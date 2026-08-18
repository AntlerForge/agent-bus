import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { makeId, nowIso } from "./ids.mjs";
import { readJsonFile, writeJsonFileAtomic } from "./io.mjs";
import { ensureBusLayout } from "./paths.mjs";
import { assertNoObviousSecrets } from "./security.mjs";

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MESSAGE_ID_PATTERN = /^ambmsg_[A-Za-z0-9_]+$/;
const DEFAULT_ROLE = "role not recorded";
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
  const agents = Object.values(await readRegistry(root));
  return agents
    .filter((agent) => include_retired || agent.lifecycle_status !== "retired")
    .sort((a, b) => a.agent_id.localeCompare(b.agent_id, undefined, { sensitivity: "base" }));
}

export async function getAmbAgent({ agent_id }, root) {
  const agentId = cleanAgentId(agent_id);
  const agent = (await readRegistry(root))[agentId];
  if (!agent) throw notFound(`No AMB agent called '${agentId}'`);
  return agent;
}

export async function registerAmbAgent({ agent_id, display_name, role }, root) {
  const agentId = cleanAgentId(agent_id);
  const displayName = display_name === undefined
    ? null
    : cleanText(display_name, "display_name", 120);
  const normalizedRole = role === undefined
    ? null
    : cleanText(role, "role", 240);

  return serializeRegistryWrite(async () => {
    const paths = await ensureBusLayout(root);
    const agents = await readRegistry(root);
    const existing = agents[agentId] || {};
    const timestamp = nowIso();
    const agent = {
      agent_id: agentId,
      display_name: displayName || existing.display_name || agentId,
      role: normalizedRole || existing.role || DEFAULT_ROLE,
      lifecycle_status: "active",
      registered_at: existing.registered_at || timestamp,
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
