import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeBridgePrompt, parseBridgeResponse } from "../src/runtime-bridge.mjs";

test("runtime bridge extracts a bounded provider response", () => {
  const parsed = parseBridgeResponse([
    "tool narration",
    "AGENT_BUS_STATUS: blocked",
    "AGENT_BUS_RESPONSE_BEGIN",
    "Need the missing chapter.",
    "AGENT_BUS_RESPONSE_END",
  ].join("\n"));
  assert.deepEqual(parsed, { status: "blocked", body: "Need the missing chapter." });
});

test("runtime bridge prompt separates provider work from transport actions", () => {
  const prompt = buildRuntimeBridgePrompt({
    agentId: "cursor",
    provider: "Cursor CLI",
    projectRoot: "/project",
    message: {
      from: "claude-code",
      to: "cursor",
      subject: "Review",
      message_id: "msg-1",
      thread_id: "thread-1",
      body: "Review this",
    },
    thread: { body: "Existing thread" },
    artifacts: [{ local_path: "/tmp/chapter.md", filename: "chapter.md", checksum: "abc" }],
  });
  assert.match(prompt, /do not call Agent Bus/);
  assert.match(prompt, /\/tmp\/chapter\.md/);
  assert.match(prompt, /Existing thread/);
  assert.match(prompt, /AGENT_BUS_RESPONSE_BEGIN/);
});
