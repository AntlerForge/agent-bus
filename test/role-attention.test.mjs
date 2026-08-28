import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerAgent, setAgentLifecycleStatus } from "../src/agents.mjs";
import { readInbox, sendMessage } from "../src/mailbox.mjs";
import { attentionSignalKey, currentReviewStatusSince, currentRunStatusSince, evaluateRoleAttention, planRoleAttention, waitingRunThresholdAt } from "../src/role-attention.mjs";
import { roleAttentionHealthFaults } from "../src/role-attention-health.mjs";

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

test("same-status run updates do not reset entry time and re-entry does", () => {
  const run = { run_id: "run_1", status: "waiting_input", started_at: "2026-08-28T00:00:00Z", updated_at: "2026-08-28T05:00:00Z" };
  const events = [
    { type: "run_started", created_at: "2026-08-28T00:00:00Z", details: { run_id: "run_1" } },
    { type: "run_updated", created_at: "2026-08-28T01:00:00Z", details: { run_id: "run_1", status: "waiting_input" } },
    { type: "run_updated", created_at: "2026-08-28T02:00:00Z", details: { run_id: "run_1", status: "waiting_input" } },
  ];
  assert.equal(currentRunStatusSince(events, run), "2026-08-28T01:00:00Z");
  events.push({ type: "run_updated", created_at: "2026-08-28T03:00:00Z", details: { run_id: "run_1", status: "running" } });
  events.push({ type: "run_updated", created_at: "2026-08-28T04:00:00Z", details: { run_id: "run_1", status: "waiting_input" } });
  assert.equal(currentRunStatusSince(events, run), "2026-08-28T04:00:00Z");
});

test("review clock uses the latest review re-entry transition", () => {
  const events = [
    { type: "status_changed", created_at: "2026-08-27T00:00:00Z", details: { to: "review" } },
    { type: "status_changed", created_at: "2026-08-27T01:00:00Z", details: { to: "in_progress" } },
    { type: "status_changed", created_at: "2026-08-28T00:00:00Z", details: { to: "review" } },
  ];
  assert.equal(currentReviewStatusSince(events, { updated_at: "2026-08-28T02:00:00Z" }), "2026-08-28T00:00:00Z");
});

test("declared waiting gate replaces the default threshold", () => {
  const entered = "2026-08-28T00:00:00Z";
  assert.equal(waitingRunThresholdAt({ next_check_at: "2026-08-29T00:00:00Z" }, entered, 14400).threshold_ms, Date.parse("2026-08-29T00:00:00Z"));
  assert.equal(waitingRunThresholdAt({}, entered, 14400).threshold_ms, Date.parse("2026-08-28T04:00:00Z"));
});

test("pending pre-submit signal retries identically; removal is quiet and rebreach is new", () => {
  const finding = { type: "waiting_run", ref: "run_1", episode_key: "waiting_run:run_1:entry_1" };
  const pending = { signal_key: "stalled:fixed", episode_keys: [finding.episode_key] };
  const retry = planRoleAttention({ evaluation: { findings: [finding] }, previous: { pending_signal: pending }, roleSeats: { attention: { last_completed_at: "2026-08-28T00:00:00Z" } }, now_ms: Date.parse("2026-08-28T01:00:00Z"), thresholds: { patrol_seconds: 14400 } });
  assert.equal(retry.signal.signal_key, "stalled:fixed");
  const removed = planRoleAttention({ evaluation: { findings: [] }, previous: { signaled_episode_keys: [finding.episode_key] }, roleSeats: { attention: { last_completed_at: "2026-08-28T00:00:00Z" } }, now_ms: Date.parse("2026-08-28T01:00:00Z"), thresholds: { patrol_seconds: 14400 } });
  assert.equal(removed.signal, null);
  const rebreach = { ...finding, episode_key: "waiting_run:run_1:entry_2" };
  assert.equal(planRoleAttention({ evaluation: { findings: [rebreach] }, previous: { signaled_episode_keys: [finding.episode_key] }, roleSeats: {}, now_ms: 0, thresholds: { patrol_seconds: 14400 } }).newly_breached.length, 1);
});

test("attention health fails stale state and recovers on fresh monitor and worker timestamps", () => {
  const now = Date.parse("2026-08-28T12:00:00Z");
  assert.equal(roleAttentionHealthFaults({ snapshot: { last_success_at: "2026-08-28T11:44:59Z" }, seats: { worker: { last_seen_at: "2026-08-28T11:59:00Z" } }, now_ms: now }).length, 1);
  assert.deepEqual(roleAttentionHealthFaults({ snapshot: { last_success_at: "2026-08-28T11:59:00Z" }, seats: { worker: { last_seen_at: "2026-08-28T11:59:00Z" } }, now_ms: now }), []);
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
  const inFlight = planRoleAttention({ evaluation: { findings: [] }, previous: {}, roleSeats: { seats: { "estate-operations-manager": { status: "occupied", how_woken: "stuck-work-signal" } } }, now_ms: Date.parse("2026-08-28T00:00:00Z"), thresholds: { patrol_seconds: 14400 } });
  assert.equal(inFlight.signal, null);
});
