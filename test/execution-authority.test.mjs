import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateMessageAuthority, MESSAGE_INTENTS } from "../src/execution-authority.mjs";
import { getThread, readInbox, sendMessage } from "../src/mailbox.mjs";
import { ensureBusLayout } from "../src/paths.mjs";
import { runRuntimeBridge } from "../src/runtime-bridge.mjs";

async function withBusRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-bus-authority-test-"));
  try {
    await ensureBusLayout(root);
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("intent vocabulary does not collide with existing ledger or API action verbs", () => {
  const existingActions = new Set([
    "propose", "propose_work_item", "transition", "assign", "start_work_run",
    "update_work_run", "receipt", "review", "send_message", "reply", "ack_message",
  ]);
  assert.deepEqual(MESSAGE_INTENTS, ["inform", "consult", "recommendation", "execute"]);
  for (const intent of MESSAGE_INTENTS) assert.equal(existingActions.has(intent), false);
});

test("missing intent and execute without authority fail closed", async () => {
  const missing = await evaluateMessageAuthority({ from: "chief-of-staff", to: "codex" });
  assert.equal(missing.disposition, "refuse");
  assert.equal(missing.reason_code, "missing_or_invalid_intent");

  const unauthorized = await evaluateMessageAuthority({
    from: "chief-of-staff", to: "codex", intent: "execute",
  });
  assert.equal(unauthorized.disposition, "refuse");
  assert.equal(unauthorized.reason_code, "missing_execution_authority");
});

test("assignment authority must match executable current assignment and recipient", async () => {
  const message = {
    from: "chief-of-staff",
    to: "codex",
    intent: "execute",
    execution_authority: {
      type: "assignment",
      work_item_id: "work_demo",
      assignment_id: "assignment_current",
    },
  };
  const allowed = await evaluateMessageAuthority(message, {
    getItem: async () => ({
      item: {
        status: "ready",
        current_assignment: { assignment_id: "assignment_current", agent_id: "codex" },
      },
    }),
  });
  assert.equal(allowed.disposition, "provider");
  assert.equal(allowed.state_changes_allowed, true);

  const stale = await evaluateMessageAuthority(message, {
    getItem: async () => ({
      item: {
        status: "ready",
        current_assignment: { assignment_id: "assignment_new", agent_id: "codex" },
      },
    }),
  });
  assert.equal(stale.reason_code, "stale_assignment");
});

test("inform intent is recorded without invoking a provider turn", async () => {
  await withBusRoot(async (root) => {
    let providerTurns = 0;
    const sent = await sendMessage({
      from: "chief-of-staff",
      to: "test-seat",
      subject: "Context only",
      body: "This is background, not an instruction.",
      requires_response: true,
      intent: "inform",
    }, root);
    await runRuntimeBridge({
      agentId: "test-seat",
      displayName: "Test Seat",
      provider: "test-provider",
      type: "test",
      once: true,
      root,
      stateDirectory: path.join(root, "state"),
      projectRoot: root,
      authorityLookup: async () => { throw new Error("inform must not query work authority"); },
      runTurn: async () => { providerTurns += 1; return { reply: "should not run" }; },
      log: () => {},
    });
    assert.equal(providerTurns, 0);
    const [message] = await readInbox({ agent: "test-seat", include_read: true }, root);
    assert.equal(message.status, "read");
    const thread = await getThread({ thread_id: sent.thread_id }, root);
    assert.equal(thread.status, "completed");
    assert.match(thread.body, /Inform intent recorded without starting a provider turn/);
  });
});

test("unauthorized execute is refused and logged without invoking a provider turn", async () => {
  await withBusRoot(async (root) => {
    let providerTurns = 0;
    const sent = await sendMessage({
      from: "chief-of-staff",
      to: "test-seat",
      subject: "Unassigned change",
      body: "Change durable state.",
      requires_response: true,
      intent: "execute",
    }, root);
    await runRuntimeBridge({
      agentId: "test-seat",
      displayName: "Test Seat",
      provider: "test-provider",
      type: "test",
      once: true,
      root,
      stateDirectory: path.join(root, "state"),
      projectRoot: root,
      authorityLookup: async () => null,
      runTurn: async () => { providerTurns += 1; return { reply: "should not run" }; },
      log: () => {},
    });
    assert.equal(providerTurns, 0);
    const thread = await getThread({ thread_id: sent.thread_id }, root);
    assert.equal(thread.status, "failed");
    assert.match(thread.body, /missing_execution_authority/);
    const reply = (await readInbox({ agent: "chief-of-staff", include_read: true }, root))[0];
    assert.match(reply.body, /Execution refused/);
  });
});

test("all persistent provider bridges select read-only modes for non-execute turns", async () => {
  const [codex, cursor, antigravity] = await Promise.all([
    readFile(new URL("../src/codex-bridge.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/cursor-bridge.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/antigravity-bridge.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(codex, /sandbox: "read-only"/);
  assert.match(cursor, /message\.state_changes_allowed.*--force/);
  assert.match(cursor, /--mode.*recommendation.*plan.*ask/);
  assert.match(antigravity, /message\.state_changes_allowed \? "accept-edits" : "plan"/);
  assert.match(antigravity, /message\.state_changes_allowed && options\.skipPermissions/);
});
