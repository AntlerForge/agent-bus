import path from "node:path";
import { authorityPrompt } from "./message-intent.mjs";

const ALLOWED_RESPONSE_STATUSES = new Set(["completed", "input_required", "blocked", "failed"]);

export function buildBootstrapPrompt(options) {
  return [
    "You are the persistent Codex responder for Agent Bus.",
    "",
    "This is a dedicated Codex CLI session. The bridge will resume this exact session for later",
    "messages from Claude or Claude Code and for terminal input from the user. Treat earlier turns in",
    "this session as durable working context.",
    "",
    "Operating rules:",
    "- Maintain context across Agent Bus and terminal turns.",
    "- The bridge handles Agent Bus ack, reply, read-state, and thread-status writes.",
    "- Do not call Agent Bus tools yourself for inbound Agent Bus messages.",
    "- Use local tools only when needed for the actual task.",
    "- Keep replies direct and suitable for forwarding when the bridge gives you an Agent Bus task.",
    "",
    `Agent Bus authority: ${process.env.AGENT_BUS_CONTROL_PLANE_URL || options.root}`,
    `Materialized artifact directory: ${path.join(path.dirname(options.sessionStore), "artifacts")}`,
    `Project root: ${options.projectRoot}`,
    "",
    "Reply exactly: CODEX_BRIDGE_SESSION_READY",
  ].join("\n");
}

export function buildAgentBusPrompt(message, threadMarkdown, options, artifacts = []) {
  return [
    "Agent Bus inbound message delivered into your persistent Codex bridge session.",
    "",
    "The bridge has already acknowledged the inbound message. Do the requested work using the",
    "persistent session context, the thread transcript below, and any referenced local files.",
    "",
    "Bridge responsibilities:",
    "- The bridge will write your final answer back to Agent Bus.",
    "- The bridge will mark the inbound message read.",
    "- The bridge will update the thread status.",
    "",
    "Response format:",
    "- Return only the reply body that should be sent to the sender.",
    "- Optional first line: STATUS: completed | input_required | blocked | failed",
    "- If the optional STATUS line is omitted, the bridge will mark the thread completed.",
    "- Do not ask the user what to do unless the task is genuinely blocked or needs their judgment.",
    "",
    `Agent Bus authority: ${process.env.AGENT_BUS_CONTROL_PLANE_URL || options.root}`,
    "Materialized artifacts:",
    ...(artifacts.length
      ? artifacts.map((artifact) => `- ${artifact.local_path || artifact.path} (${artifact.filename || artifact.artifact_id})`)
      : ["- none"]),
    "",
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Message ID: ${message.message_id}`,
    `Thread ID: ${message.thread_id}`,
    `Sequence: ${message.seq}`,
    `Intent: ${message.intent}`,
    authorityPrompt(message.intent, message.state_changes_allowed === true),
    "",
    "Current thread transcript:",
    threadMarkdown || "(thread transcript unavailable)",
    "",
    "Inbound message body:",
    message.body,
  ].join("\n");
}

export function buildTerminalPrompt(input, options) {
  return [
    "Terminal input from the user into the persistent Codex Agent Bus bridge session.",
    "",
    "Reply to the user in this terminal. Use the persistent context from prior terminal and Agent Bus",
    "turns. If the user asks you to prepare a message for Claude, draft it clearly; the bridge terminal",
    "does not automatically send terminal replies to Agent Bus unless a bridge command says so.",
    "",
    `Agent Bus root: ${options.root}`,
    `Shared artifact directory: ${path.join(options.root, "shared")}`,
    "",
    "User input:",
    input,
  ].join("\n");
}

export function parseResponseStatus(replyBody) {
  const match = replyBody.match(/^STATUS:\s*(completed|input_required|blocked|failed)\s*(?:\r?\n|$)/i);
  if (!match) {
    return { status: "completed", body: replyBody.trim() };
  }

  const status = match[1].toLowerCase();
  const body = replyBody.slice(match[0].length).trim();
  return {
    status: ALLOWED_RESPONSE_STATUSES.has(status) ? status : "completed",
    body: body || replyBody.trim(),
  };
}
