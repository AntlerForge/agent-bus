import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { makeId, nowIso } from "./ids.mjs";
import { readJsonFile, writeJsonFileAtomic } from "./io.mjs";
import { ensureBusLayout } from "./paths.mjs";
import { assertNoObviousSecrets } from "./security.mjs";

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MESSAGE_ID_PATTERN = /^ambmsg_[A-Za-z0-9_]+$/;
const DEFAULT_ROLE = "role not recorded";
const MAX_RECENT_WORK_LENGTH = 500;
const MAX_CHAT_LOCATOR_LENGTH = 500;
const MAX_TAGS = 16;
const MAX_TAG_LENGTH = 64;
const MAX_BODY_LENGTH = 32 * 1024;

let ambRegistryWriteQueue = Promise.resolve();

function serializeRegistryWrite(operation) {
  const queued = ambRegistryWriteQueue.then(operation, operation);
  ambRegistryWriteQueue = queued.catch(() => {});
  return queued;
}

function cleanAgentId(value, label = "agent_id") {
  const normalized = String(value || "").trim();
  if (!AGENT_ID_PATTERN.test(normalized)) {
    throw new Error(`${label} must be 1-64 characters using letters, digits, dot, underscore or hyphen`);
  }
  return normalized;
}

function cleanText(value, label, maxLength, { required = true } = {}) {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) throw new Error(`${label} is required`);
  if (normalized.length > maxLength) throw new Error(`${label} must be at most ${maxLength} characters`);
  return normalized;
}

function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

async function readRegistry(root) {
  const paths = await ensureBusLayout(root);
  return readJsonFile(paths.ambAgentsFile, {});
}

function normalizeTags(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new Error("tags must be an array");
  const tags = [...new Set(value.map((tag) => cleanText(tag, "tag", MAX_TAG_LENGTH).toLowerCase()))];
  if (tags.length > MAX_TAGS) throw new Error(`tags must contain at most ${MAX_TAGS} values`);
  return tags;
}

function normalizeAgentRecord(agent) {
  return {
    ...agent,
    recent_work: typeof agent.recent_work === "string" ? agent.recent_work : "",
    tags: Array.isArray(agent.tags) ? agent.tags : [],
    chat_locator: typeof agent.chat_locator === "string" ? agent.chat_locator : "",
    last_active_at: agent.last_active_at || agent.updated_at || agent.registered_at || null,
  };
}

function topicTokens(value) {
  return [...new Set(String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1))];
}

function topicScore(agent, query, queryTokens) {
  const recent = String(agent.recent_work || "").toLowerCase();
  const tags = new Set((agent.tags || []).flatMap(topicTokens));
  const roleTokens = new Set(topicTokens(agent.role));
  const identityTokens = new Set(topicTokens(`${agent.agent_id} ${agent.display_name}`));
  const recentTokens = new Set(topicTokens(recent));
  let score = recent.includes(query.toLowerCase()) ? 100 : 0;
  const matched = [];
  for (const token of queryTokens) {
    let tokenScore = 0;
    if (tags.has(token)) tokenScore = Math.max(tokenScore, 30);
    if (recentTokens.has(token)) tokenScore = Math.max(tokenScore, 20);
    if (roleTokens.has(token)) tokenScore = Math.max(tokenScore, 6);
    if (identityTokens.has(token)) tokenScore = Math.max(tokenScore, 4);
    if (tokenScore) matched.push(token);
    score += tokenScore;
  }
  return { score, matched };
}

async function requireActiveAgent(agentId, root) {
  const agents = await readRegistry(root);
  const agent = agents[agentId];
  if (!agent || agent.lifecycle_status === "retired") {
    throw notFound(`No active AMB agent called '${agentId}'`);
  }
  return agent;
}

function messagePath(paths, agentId, messageId) {
  return path.join(paths.ambInbox, agentId, `${messageId}.json`);
}

export async function listAmbAgents({ include_retired = false } = {}, root) {
  const agents = Object.values(await readRegistry(root)).map(normalizeAgentRecord);
  return agents
    .filter((agent) => include_retired || agent.lifecycle_status !== "retired")
    .sort((a, b) => a.agent_id.localeCompare(b.agent_id, undefined, { sensitivity: "base" }));
}

export async function getAmbAgent({ agent_id }, root) {
  const agentId = cleanAgentId(agent_id);
  const agent = (await readRegistry(root))[agentId];
  if (!agent) throw notFound(`No AMB agent called '${agentId}'`);
  return normalizeAgentRecord(agent);
}

export async function registerAmbAgent({ agent_id, display_name, role, recent_work, tags, chat_locator }, root) {
  const agentId = cleanAgentId(agent_id);
  const displayName = display_name === undefined
    ? null
    : cleanText(display_name, "display_name", 120);
  const normalizedRole = role === undefined
    ? null
    : cleanText(role, "role", 240);
  const normalizedRecentWork = recent_work === undefined
    ? null
    : cleanText(recent_work, "recent_work", MAX_RECENT_WORK_LENGTH, { required: false });
  const normalizedTags = normalizeTags(tags);
  const normalizedChatLocator = chat_locator === undefined
    ? null
    : cleanText(chat_locator, "chat_locator", MAX_CHAT_LOCATOR_LENGTH, { required: false });

  return serializeRegistryWrite(async () => {
    const paths = await ensureBusLayout(root);
    const agents = await readRegistry(root);
    const existing = normalizeAgentRecord(agents[agentId] || {});
    const timestamp = nowIso();
    const agent = {
      agent_id: agentId,
      display_name: displayName || existing.display_name || agentId,
      role: normalizedRole || existing.role || DEFAULT_ROLE,
      recent_work: normalizedRecentWork ?? existing.recent_work,
      tags: normalizedTags ?? existing.tags,
      chat_locator: normalizedChatLocator ?? existing.chat_locator,
      lifecycle_status: "active",
      registered_at: existing.registered_at || timestamp,
      last_active_at: timestamp,
      updated_at: timestamp,
      retired_at: null,
      retired_by: null,
    };
    agents[agentId] = agent;
    await writeJsonFileAtomic(paths.ambAgentsFile, agents);
    await mkdir(path.join(paths.ambInbox, agentId), { recursive: true });
    return agent;
  });
}

export async function findAmbAgents({ query }, root) {
  const normalizedQuery = cleanText(query, "query", 240);
  const queryTokens = topicTokens(normalizedQuery);
  if (!queryTokens.length) throw new Error("query must contain searchable letters or digits");
  const candidates = [];
  for (const agent of await listAmbAgents({}, root)) {
    const { score, matched } = topicScore(agent, normalizedQuery, queryTokens);
    if (!score) continue;
    candidates.push({ ...agent, relevance_score: score, matched_terms: matched });
  }
  candidates.sort((a, b) => (
    b.relevance_score - a.relevance_score
    || String(b.last_active_at || "").localeCompare(String(a.last_active_at || ""))
    || a.agent_id.localeCompare(b.agent_id, undefined, { sensitivity: "base" })
  ));
  return {
    query: normalizedQuery,
    query_tokens: queryTokens,
    ambiguous: candidates.length > 1 && candidates[0].relevance_score === candidates[1].relevance_score,
    results: candidates,
  };
}

export async function retireAmbAgent({ agent_id, actor }, root) {
  const agentId = cleanAgentId(agent_id);
  return serializeRegistryWrite(async () => {
    const paths = await ensureBusLayout(root);
    const agents = await readRegistry(root);
    const agent = agents[agentId];
    if (!agent) throw notFound(`No AMB agent called '${agentId}'`);
    const timestamp = nowIso();
    agents[agentId] = {
      ...agent,
      lifecycle_status: "retired",
      updated_at: timestamp,
      retired_at: timestamp,
      retired_by: actor ? cleanAgentId(actor, "actor") : null,
    };
    await writeJsonFileAtomic(paths.ambAgentsFile, agents);
    return agents[agentId];
  });
}

export async function sendAmbMessage({ from, to, body }, root) {
  const sender = cleanAgentId(from, "from");
  const recipient = cleanAgentId(to, "to");
  const messageBody = cleanText(body, "body", MAX_BODY_LENGTH);
  assertNoObviousSecrets(messageBody);
  await Promise.all([requireActiveAgent(sender, root), requireActiveAgent(recipient, root)]);

  const paths = await ensureBusLayout(root);
  const message = {
    message_id: makeId("ambmsg"),
    from: sender,
    to: recipient,
    created_at: nowIso(),
    status: "unread",
    read_at: null,
    body: messageBody,
  };
  await writeJsonFileAtomic(messagePath(paths, recipient, message.message_id), message);
  return message;
}

export async function readAmbInbox({ agent, include_read = false }, root) {
  const agentId = cleanAgentId(agent, "agent");
  await requireActiveAgent(agentId, root);
  const paths = await ensureBusLayout(root);
  const directory = path.join(paths.ambInbox, agentId);
  await mkdir(directory, { recursive: true });
  const messages = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const message = await readJsonFile(path.join(directory, entry.name), null);
    if (!message) continue;
    if (!include_read && message.status === "read") continue;
    messages.push(message);
  }
  messages.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return messages;
}

export async function markAmbMessageRead({ agent, message_id }, root) {
  const agentId = cleanAgentId(agent, "agent");
  const messageId = String(message_id || "").trim();
  if (!MESSAGE_ID_PATTERN.test(messageId)) throw new Error("message_id is invalid");
  await requireActiveAgent(agentId, root);
  const paths = await ensureBusLayout(root);
  const filePath = messagePath(paths, agentId, messageId);
  const message = await readJsonFile(filePath, null);
  if (!message || message.to !== agentId) throw notFound(`AMB message not found: ${messageId}`);
  if (message.status !== "read") {
    message.status = "read";
    message.read_at = nowIso();
    await writeJsonFileAtomic(filePath, message);
  }
  return message;
}
