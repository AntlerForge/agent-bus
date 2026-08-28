#!/usr/bin/env node
import path from "node:path";
import { createRemoteRoleSeats } from "../src/role-seats-remote.mjs";
import { evaluateRoleAttention, planRoleAttention, DEFAULT_ROLE_ATTENTION_THRESHOLDS } from "../src/role-attention.mjs";
import { readJsonFile, writeJsonFileAtomic } from "../src/io.mjs";
import { getBusRoot } from "../src/paths.mjs";
import { getWriteToken } from "../src/write-token.mjs";
import { getRoleWakeCredential, ROLE_WAKE_MONITOR } from "../src/role-wake-auth.mjs";

const credential = getRoleWakeCredential();
if (credential?.identity !== ROLE_WAKE_MONITOR) throw new Error("Estate operations monitor credential is required");
const number = (name, fallback) => Number(process.env[name] || fallback);
const thresholds = {
  unread_response_seconds: number("ROLE_ATTENTION_UNREAD_SECONDS", DEFAULT_ROLE_ATTENTION_THRESHOLDS.unread_response_seconds),
  waiting_run_seconds: number("ROLE_ATTENTION_WAITING_RUN_SECONDS", DEFAULT_ROLE_ATTENTION_THRESHOLDS.waiting_run_seconds),
  pending_review_seconds: number("ROLE_ATTENTION_REVIEW_SECONDS", DEFAULT_ROLE_ATTENTION_THRESHOLDS.pending_review_seconds),
  patrol_seconds: number("ROLE_ATTENTION_PATROL_SECONDS", DEFAULT_ROLE_ATTENTION_THRESHOLDS.patrol_seconds),
};
const root = getBusRoot();
const snapshotFile = path.join(root, "_role-attention-monitor.json");
const url = process.env.AGENT_BUS_CONTROL_PLANE_URL || "http://127.0.0.1:18091/agent-bus";
const client = createRemoteRoleSeats(url, { writeToken: getWriteToken(), roleWakeCredential: credential });
const previous = await readJsonFile(snapshotFile, { schema_version: 1, signaled_episode_keys: [] });
const roleSeats = await client.list();
const evaluation = await evaluateRoleAttention({ thresholds }, root);
const plan = planRoleAttention({ evaluation, previous, roleSeats, thresholds });
let pendingSignal = previous.pending_signal || null;
if (plan.signal && !pendingSignal) pendingSignal = { ...plan.signal, created_at: evaluation.evaluated_at };
let snapshot = {
  schema_version: 1, last_evaluated_at: evaluation.evaluated_at, last_success_at: previous.last_success_at || null,
  effective_thresholds: thresholds,
  active_findings: evaluation.findings,
  active_finding_counts: evaluation.findings.reduce((out, item) => ({ ...out, [item.type]: (out[item.type] || 0) + 1 }), {}),
  newly_breached_refs: plan.newly_breached.map((item) => ({ type: item.type, ref: item.ref, episode_key: item.episode_key })),
  signaled_episode_keys: previous.signaled_episode_keys || [], pending_signal: pendingSignal,
  last_signal: previous.last_signal || null,
  last_completed_attention_pass_at: roleSeats.attention?.last_completed_at || null,
  last_completed_attention_pass_seat_id: roleSeats.attention?.last_completed_seat_id || null,
  next_patrol_due_at: new Date(new Date(roleSeats.attention?.last_completed_at || 0).getTime() + thresholds.patrol_seconds * 1000).toISOString(),
};
await writeJsonFileAtomic(snapshotFile, snapshot);

let disposition = "no_new_breach";
if (pendingSignal) {
  const selected = evaluation.findings.filter((item) => pendingSignal.episode_keys.includes(item.episode_key));
  const counts = selected.reduce((out, item) => ({ ...out, [item.type]: (out[item.type] || 0) + 1 }), {});
  const summary = pendingSignal.signal_type === "patrol_due"
    ? "Routine Estate Operations Manager patrol: reconcile stalled work, automation health, ownership and closure traces within the role charter."
    : `Estate attention monitor found ${Object.entries(counts).map(([type, count]) => `${count} ${type.replaceAll("_", " ")}`).join(", ")} newly breached. Work the operations queue and route each item without notifying Tony merely because this signal fired.`;
  const signal = await client.signal({ signal_type: pendingSignal.signal_type, signal_key: pendingSignal.signal_key, episode_keys: pendingSignal.episode_keys, reason: summary, source_ref: "agent-bus:role-attention-monitor", detected_at: evaluation.evaluated_at });
  disposition = signal.disposition;
  snapshot.signaled_episode_keys = [...new Set([...snapshot.signaled_episode_keys, ...pendingSignal.episode_keys])];
  snapshot.pending_signal = null;
  snapshot.last_signal = { signal_key: pendingSignal.signal_key, disposition, created_at: evaluation.evaluated_at };
}
snapshot.last_success_at = new Date().toISOString();
await writeJsonFileAtomic(snapshotFile, snapshot);
process.stdout.write(`${JSON.stringify({ ...evaluation, newly_breached: plan.newly_breached.length, disposition })}\n`);
