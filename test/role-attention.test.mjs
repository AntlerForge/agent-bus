import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerAgent, setAgentLifecycleStatus } from "../src/agents.mjs";
import { readInbox, sendMessage } from "../src/mailbox.mjs";
import { attentionSignalKey, evaluateRoleAttention, planRoleAttention } from "../src/role-attention.mjs";

test("attention monitor raises only aged response-required unread messages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "role-attention-"));
  await registerAgent({ agent_id: "coherence-manager" }, root);
  await sendMessage({ from: "chief-of-staff", to: "coherence-manager", subject: "Review", body: "Please review", requires_response: true, intent: "consult" }, root);
  const early = await evaluateRoleAttention({ now_ms: Date.now(), thresholds: { unread_response_seconds: 3600, waiting_run_seconds: 3600, pending_review_seconds: 3600 } }, root);
  assert.equal(early.findings.length, 0);
  const late = await evaluateRoleAttention({ now_ms: Date.now() + 3601_000, thresholds: { unread_response_seconds: 3600, waiting_run_seconds: 3600, pending_review_seconds: 3600 } }, root);
  assert.equal(late.findings[0].type, "unread_response");
  assert.match(late.findings[0].episode_key, /^unread_response:/);
});

test("attention threshold is inclusive and retired recipients are excluded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "role-attention-"));
  await registerAgent({ agent_id: "active-role" }, root);
  await registerAgent({ agent_id: "retired-role" }, root);
  await setAgentLifecycleStatus({ agent_id: "retired-role", status: "retired", actor: "test" }, root);
  await sendMessage({ from: "chief-of-staff", to: "active-role", subject: "Review", body: "Review", requires_response: true, intent: "consult" }, root);
  await sendMessage({ from: "chief-of-staff", to: "retired-role", subject: "Old", body: "Old", requires_response: true, intent: "consult" }, root);
  const created = new Date((await readInbox({ agent: "active-role" }, root))[0].created).getTime();
  const thresholds = { unread_response_seconds: 3600, waiting_run_seconds: 3600, pending_review_seconds: 3600 };
  assert.equal((await evaluateRoleAttention({ now_ms: created + 3_599_999, thresholds }, root)).findings.length, 0);
  const atBoundary = await evaluateRoleAttention({ now_ms: created + 3_600_000, thresholds }, root);
  assert.deepEqual(atBoundary.findings.map((item) => item.owner), ["active-role"]);
});

test("attention plan signals only new episodes and patrols from completed passes", () => {
  const first = { evaluated_at: "2026-08-28T00:00:00Z", findings: [{ type: "waiting_run", ref: "run_1", episode_key: "waiting_run:run_1:entry_1" }] };
  const plan = planRoleAttention({ evaluation: first, previous: {}, roleSeats: { attention: { last_completed_at: "2026-08-27T23:00:00Z" } }, now_ms: Date.parse("2026-08-28T00:00:00Z"), thresholds: { patrol_seconds: 14400 } });
  assert.equal(plan.newly_breached.length, 1);
  assert.equal(plan.signal.signal_key, attentionSignalKey(["waiting_run:run_1:entry_1"]));
  const repeat = planRoleAttention({ evaluation: first, previous: { signaled_episode_keys: ["waiting_run:run_1:entry_1"] }, roleSeats: { attention: { last_completed_at: "2026-08-27T23:00:00Z" } }, now_ms: Date.parse("2026-08-28T00:00:00Z"), thresholds: { patrol_seconds: 14400 } });
  assert.equal(repeat.signal, null);
  const patrol = planRoleAttention({ evaluation: { findings: [] }, previous: {}, roleSeats: { attention: { last_completed_at: "2026-08-27T19:59:59Z" } }, now_ms: Date.parse("2026-08-28T00:00:00Z"), thresholds: { patrol_seconds: 14400 } });
  assert.equal(patrol.signal.signal_type, "patrol_due");
});
