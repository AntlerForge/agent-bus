import { readInbox } from "./mailbox.mjs";

export function pendingChannelMessages(messages) {
  return messages.filter((message) => message.status !== "read" && message.requires_response === true);
}

export async function readPendingAgentMessages(root, agent = "claude-code") {
  const messages = await readInbox({ agent, include_read: false }, root);
  return pendingChannelMessages(messages);
}

export function formatChannelContent(message) {
  return [
    "Agent Bus message for Claude Code.",
    "",
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Message ID: ${message.message_id}`,
    `Thread ID: ${message.thread_id}`,
    `Sequence: ${message.seq}`,
    "",
    "Use the agent-bus skill and MCP tools. Acknowledge this message, handle the task in this Claude Code session, reply to Codex in the same thread, mark the inbound message read, and update the thread status. Do not ask the user what to do unless there is a real blocker.",
    "",
    "Message body:",
    message.body,
  ].join("\n");
}

export function channelMeta(message) {
  return {
    message_id: String(message.message_id),
    thread_id: String(message.thread_id),
    from_agent: String(message.from),
    to_agent: String(message.to),
    seq: String(message.seq),
    priority: String(message.priority || "normal"),
  };
}
