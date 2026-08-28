#!/usr/bin/env node
import { createRemoteRoleSeats } from "../src/role-seats-remote.mjs";
import { evaluateRoleAttention, DEFAULT_ROLE_ATTENTION_THRESHOLDS } from "../src/role-attention.mjs";
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
const url = process.env.AGENT_BUS_CONTROL_PLANE_URL || "http://127.0.0.1:18091/agent-bus";
const client = createRemoteRoleSeats(url, { writeToken: getWriteToken(), roleWakeCredential: credential });
const result = await evaluateRoleAttention({ thresholds }, getBusRoot());
if (result.findings.length) {
  const counts = result.findings.reduce((out, item) => ({ ...out, [item.type]: (out[item.type] || 0) + 1 }), {});
  const summary = Object.entries(counts).map(([type, count]) => `${count} ${type.replaceAll("_", " ")}`).join(", ");
  const signal = await client.signal({ signal_type: "stalled_work", signal_key: result.signal_key, reason: `Estate attention monitor found ${summary}. Work the operations queue and route each item without notifying Tony merely because this signal fired.`, source_ref: "agent-bus:role-attention-monitor", detected_at: result.evaluated_at, suppress_for_seconds: thresholds.patrol_seconds });
  process.stdout.write(`${JSON.stringify({ ...result, disposition: signal.disposition })}\n`);
} else {
  const state = await client.list();
  const lastPatrol = (state.signals || []).filter((item) => item.signal_type === "patrol_due").at(-1);
  if (!lastPatrol || Date.now() - new Date(lastPatrol.created_at).getTime() >= thresholds.patrol_seconds * 1000) {
    const bucket = Math.floor(Date.now() / (thresholds.patrol_seconds * 1000));
    const signal = await client.signal({ signal_type: "patrol_due", signal_key: `patrol:${bucket}`, reason: "Routine Estate Operations Manager patrol: reconcile stalled work, automation health, ownership and closure traces within the role charter.", source_ref: "agent-bus:role-attention-monitor", detected_at: result.evaluated_at, suppress_for_seconds: thresholds.patrol_seconds });
    process.stdout.write(`${JSON.stringify({ ...result, disposition: signal.disposition })}\n`);
  } else process.stdout.write(`${JSON.stringify({ ...result, disposition: "patrol_not_due" })}\n`);
}
