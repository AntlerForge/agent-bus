import { mkdir } from "node:fs/promises";
import path from "node:path";
import { registerAgent } from "./agents.mjs";
import { ackMessage, getThread, markRead, readInbox, replyMessage, updateThreadStatus } from "./mailbox.mjs";
import { ensureBusLayout } from "./paths.mjs";
import { configuredRemoteBus } from "./remote-bus.mjs";
import { createQueue } from "./task-queue.mjs";

const RESPONSE_STATUSES = new Set(["completed", "input_required", "blocked", "failed"]);

function now() {
  return new Date().toISOString();
}

export function bridgeLog(agentId, message) {
  console.log(JSON.stringify({ timestamp: now(), service: `agent-bus-${agentId}-bridge`, level: "INFO", message }));
}

export function parseBridgeResponse(raw) {
  const text = String(raw || "").trim();
  const statusMatch = text.match(/(?:^|\n)AGENT_BUS_STATUS:\s*(completed|input_required|blocked|failed)\s*(?:\n|$)/i)
    || text.match(/^STATUS:\s*(completed|input_required|blocked|failed)\s*(?:\r?\n|$)/i);
  const status = statusMatch && RESPONSE_STATUSES.has(statusMatch[1].toLowerCase())
    ? statusMatch[1].toLowerCase()
    : "completed";
  const begin = text.lastIndexOf("AGENT_BUS_RESPONSE_BEGIN");
  const end = begin >= 0 ? text.indexOf("AGENT_BUS_RESPONSE_END", begin) : -1;
  if (begin >= 0 && end > begin) {
    const body = text.slice(begin + "AGENT_BUS_RESPONSE_BEGIN".length, end).trim();
    return { status, body };
  }
  const body = text
    .replace(/(?:^|\n)AGENT_BUS_STATUS:\s*(?:completed|input_required|blocked|failed)\s*(?:\n|$)/i, "\n")
    .replace(/^STATUS:\s*(?:completed|input_required|blocked|failed)\s*(?:\r?\n|$)/i, "")
    .trim();
  return { status, body };
}

export function buildRuntimeBridgePrompt({ agentId, provider, message, thread, artifacts = [], projectRoot }) {
  const artifactLines = artifacts.length
    ? artifacts.map((artifact) => `- ${artifact.local_path || artifact.path} (${artifact.filename || artifact.artifact_id}, sha256 ${artifact.checksum || "unknown"})`)
    : ["- none"];
  return [
    `You are the ${provider} runtime connected to Tony's Agent Bus as ${agentId}.`,
    "",
    "The bridge has already acknowledged this request. Perform the task itself; do not call Agent Bus",
    "tools to acknowledge, reply, mark read or change thread status because the bridge owns those actions.",
    "Use referenced files and tools only as needed for the requested work.",
    "",
    "Return a concise result suitable for the requesting agent. Your final response MUST end with:",
    "AGENT_BUS_STATUS: completed | input_required | blocked | failed",
    "AGENT_BUS_RESPONSE_BEGIN",
    "<the reply body to send back>",
    "AGENT_BUS_RESPONSE_END",
    "",
    `Working directory: ${projectRoot}`,
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Message ID: ${message.message_id}`,
    `Thread ID: ${message.thread_id}`,
    "",
    "Materialized artifacts:",
    ...artifactLines,
    "",
    "Current thread transcript:",
    thread?.body || "(thread transcript unavailable)",
    "",
    "Task to perform:",
    message.body,
  ].join("\n");
}

async function registerHeartbeat(options) {
  const args = {
    agent_id: options.agentId,
    display_name: options.displayName,
    type: options.type,
    capabilities: [...new Set([...(options.capabilities || []), "agent-bus-auto-response"])],
  };
  const remote = configuredRemoteBus();
  return remote ? remote.registerAgent(args) : registerAgent(args, options.root);
}

async function materializeArtifacts(message, options) {
  const remote = configuredRemoteBus();
  if (!remote) {
    return (message.artifact_paths || []).map((artifactPath) => ({
      path: artifactPath,
      local_path: artifactPath,
      filename: path.basename(artifactPath),
    }));
  }
  const directory = path.join(options.stateDirectory, "artifacts", message.thread_id);
  return remote.materializeMessageArtifacts(message, directory);
}

async function handleMessage(message, options) {
  options.log(`Handling ${message.message_id} from ${message.from}: ${message.subject}`);
  await ackMessage({ message_id: message.message_id }, options.root);
  await updateThreadStatus({ thread_id: message.thread_id, status: "in_progress" }, options.root);

  try {
    const [thread, artifacts] = await Promise.all([
      getThread({ thread_id: message.thread_id }, options.root),
      materializeArtifacts(message, options),
    ]);
    const prompt = buildRuntimeBridgePrompt({
      agentId: options.agentId,
      provider: options.provider,
      message,
      thread,
      artifacts,
      projectRoot: options.projectRoot,
    });
    const result = await options.runTurn({ prompt, message, thread, artifacts });
    const parsed = parseBridgeResponse(result.reply);
    if (!parsed.body) throw new Error(`${options.provider} produced an empty reply`);
    const reply = await replyMessage({
      from: options.agentId,
      to: message.from,
      thread_id: message.thread_id,
      body: parsed.body,
      requires_response: false,
    }, options.root);
    await markRead({ message_id: message.message_id }, options.root);
    await updateThreadStatus({ thread_id: message.thread_id, status: parsed.status }, options.root);
    options.log(`Replied with ${reply.message_id}; set ${message.thread_id} to ${parsed.status}; session ${result.session_id || "unknown"}.`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await replyMessage({
      from: options.agentId,
      to: message.from,
      thread_id: message.thread_id,
      body: `${options.displayName} bridge failed while processing this request.\n\n${reason}`,
      requires_response: false,
    }, options.root);
    await markRead({ message_id: message.message_id }, options.root);
    await updateThreadStatus({ thread_id: message.thread_id, status: "failed" }, options.root);
    options.log(`Failed ${message.message_id}: ${reason}`);
  }
}

async function processInbox(options, queue, active) {
  const messages = (await readInbox({ agent: options.agentId, include_read: false }, options.root)).filter(
    (message) => message.requires_response === true && message.status !== "read" && !active.has(message.message_id),
  );
  for (const message of messages) {
    active.add(message.message_id);
    queue.enqueue(async () => {
      try {
        await handleMessage(message, options);
      } finally {
        active.delete(message.message_id);
      }
    });
  }
}

export async function runRuntimeBridge(options) {
  const normalized = {
    pollMs: 2000,
    heartbeatMs: 30000,
    once: false,
    root: undefined,
    capabilities: [],
    log: (message) => bridgeLog(options.agentId, message),
    ...options,
  };
  if (!normalized.agentId || !normalized.runTurn) throw new Error("agentId and runTurn are required");
  await mkdir(normalized.stateDirectory, { recursive: true });
  if (!configuredRemoteBus()) await ensureBusLayout(normalized.root);
  await registerHeartbeat(normalized);
  normalized.log(`Watching ${normalized.agentId}; authority ${process.env.AGENT_BUS_CONTROL_PLANE_URL || normalized.root || "local default"}.`);

  const queue = createQueue({ log: normalized.log });
  const active = new Set();
  await processInbox(normalized, queue, active);
  if (normalized.once) {
    await queue.waitForIdle();
    return;
  }
  setInterval(() => {
    processInbox(normalized, queue, active).catch((error) => normalized.log(`Poll failed: ${error.message}`));
  }, normalized.pollMs);
  setInterval(() => {
    registerHeartbeat(normalized).catch((error) => normalized.log(`Heartbeat failed: ${error.message}`));
  }, normalized.heartbeatMs);
}
