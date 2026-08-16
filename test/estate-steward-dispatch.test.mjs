import assert from "node:assert/strict";
import test from "node:test";
import { dispatchOutcomeFailure, dispatchSentinelDeadman } from "../src/estate-steward/dispatch.mjs";

test("sustained outcome failure is dispatched idempotently to Codex", async () => {
  const sent = [];
  const bus = { sendMessage: async (message) => { sent.push(message); return { message_id: "m1", thread_id: "t1" }; } };
  const result = await dispatchOutcomeFailure({
    bus,
    evidencePath: "/runtime/cards.json",
    transition: {
      type: "escalated",
      notify: true,
      card: {
        card_id: "matrix:mac-reporter-freshness",
        check_id: "mac-reporter-freshness",
        first_seen: "2026-08-12T06:00:00Z",
        last_seen: "2026-08-12T07:00:00Z",
        actual: false,
        expected: true,
        recovery_contract: "fresh Mac report",
      },
    },
  });
  assert.equal(result.thread_id, "t1");
  assert.equal(sent[0].to, "codex");
  assert.equal(sent[0].intent, "execute");
  assert.deepEqual(sent[0].execution_authority, { type: "trusted_policy", policy_id: "estate-steward-repair" });
  assert.equal(sent[0].idempotency_key, "estate-outcome:matrix:mac-reporter-freshness:2026-08-12T06:00:00Z");
  assert.match(sent[0].body, /Do not notify Tony/);
  assert.match(sent[0].body, /false positive or recurring defect/);
});

test("recovery transitions stay silent", async () => {
  const bus = { sendMessage: async () => { throw new Error("must not send"); } };
  assert.equal(await dispatchOutcomeFailure({ transition: { type: "recovered", notify: true }, bus }), null);
});

test("deadman asks an agent to restore the observer", async () => {
  const sent = [];
  await dispatchSentinelDeadman({ bucket: "2026-08-12T08", maxMinutes: 35, bus: { sendMessage: async (message) => sent.push(message) } });
  assert.equal(sent[0].to, "codex");
  assert.equal(sent[0].intent, "execute");
  assert.match(sent[0].body, /restore it on A6/);
});
