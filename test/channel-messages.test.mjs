import test from "node:test";
import assert from "node:assert/strict";
import { channelMeta, formatChannelContent, pendingChannelMessages } from "../src/channel-messages.mjs";

const baseMessage = {
  message_id: "msg_1",
  thread_id: "thread_1",
  seq: 1,
  from: "codex",
  to: "claude-code",
  status: "unread",
  subject: "Smoke test",
  priority: "normal",
  requires_response: true,
  body: "Please confirm the channel event arrived.",
};

test("pendingChannelMessages only includes unread messages that require a response", () => {
  const messages = [
    baseMessage,
    { ...baseMessage, message_id: "msg_2", requires_response: false },
    { ...baseMessage, message_id: "msg_3", status: "read" },
  ];

  assert.deepEqual(
    pendingChannelMessages(messages).map((message) => message.message_id),
    ["msg_1"],
  );
});

test("formatChannelContent includes routing and action instructions", () => {
  const content = formatChannelContent(baseMessage);

  assert.match(content, /Message ID: msg_1/);
  assert.match(content, /Thread ID: thread_1/);
  assert.match(content, /reply to Codex in the same thread/);
  assert.match(content, /Please confirm the channel event arrived/);
});

test("channelMeta uses identifier-safe string keys for Claude channel attributes", () => {
  assert.deepEqual(channelMeta(baseMessage), {
    message_id: "msg_1",
    thread_id: "thread_1",
    from_agent: "codex",
    to_agent: "claude-code",
    seq: "1",
    priority: "normal",
  });
});
