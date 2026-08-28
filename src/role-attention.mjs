import { createHash } from "node:crypto";
import { listAgents } from "./agents.mjs";
import { readInbox } from "./mailbox.mjs";
import { listWorkItemEvents, listWorkItems } from "./work-ledger/store.mjs";

export const DEFAULT_ROLE_ATTENTION_THRESHOLDS = Object.freeze({
  unread_response_seconds: 4 * 60 * 60,
  waiting_run_seconds: 4 * 60 * 60,
  pending_review_seconds: 24 * 60 * 60,
  patrol_seconds: 4 * 60 * 60,
});

function ageSeconds(value, nowMs) {
  const then = new Date(value).getTime();
  return Number.isFinite(then) ? Math.max(0, (nowMs - then) / 1000) : 0;
}

export function attentionSignalKey(episodeKeys) {
  return `stalled:${createHash("sha256").update(JSON.stringify([...episodeKeys].sort())).digest("hex").slice(0, 24)}`;
}

function currentRunSince(events, run) {
  const entered = [...events].reverse().find((event) => event.type === "run_updated" && event.details?.run_id === run.run_id && event.details?.status === run.status);
  return entered?.created_at || run.updated_at;
}

function currentReviewSince(events, item) {
  const entered = [...events].reverse().find((event) => event.type === "status_changed" && event.details?.to === "review");
  return entered?.created_at || item.updated_at;
}

export async function evaluateRoleAttention({ now_ms = Date.now(), thresholds = DEFAULT_ROLE_ATTENTION_THRESHOLDS } = {}, root) {
  const findings = [];
  for (const agent of await listAgents(root)) {
    if (agent.lifecycle_status === "retired") continue;
    for (const message of await readInbox({ agent: agent.agent_id }, root)) {
      if (message.status === "read" || !message.requires_response) continue;
      const age = ageSeconds(message.created, now_ms);
      if (age >= thresholds.unread_response_seconds) findings.push({
        type: "unread_response", ref: message.message_id, owner: agent.agent_id,
        breach_start: message.created, episode_key: `unread_response:${message.message_id}:${message.created}`,
        age_seconds: Math.floor(age),
      });
    }
  }
  const items = await listWorkItems({}, root);
  for (const item of items) {
    const events = await listWorkItemEvents({ work_item_id: item.work_item_id }, root);
    for (const run of item.runs || []) {
      if (!["waiting_input", "blocked"].includes(run.status)) continue;
      const enteredAt = currentRunSince(events, run);
      const gate = run.not_before || run.next_check_at || null;
      const thresholdAt = gate ? new Date(gate).getTime() : new Date(enteredAt).getTime() + thresholds.waiting_run_seconds * 1000;
      if (now_ms >= thresholdAt) findings.push({
        type: "waiting_run", ref: run.run_id, work_item_id: item.work_item_id,
        breach_start: new Date(thresholdAt).toISOString(), episode_key: `waiting_run:${run.run_id}:${enteredAt}`,
        age_seconds: Math.floor(ageSeconds(enteredAt, now_ms)), gate: gate || null,
      });
    }
    if (item.status === "review") {
      const enteredAt = currentReviewSince(events, item);
      const age = ageSeconds(enteredAt, now_ms);
      if (age >= thresholds.pending_review_seconds) findings.push({
        type: "pending_review", ref: item.work_item_id, breach_start: enteredAt,
        episode_key: `pending_review:${item.work_item_id}:${enteredAt}`, age_seconds: Math.floor(age),
      });
    }
  }
  findings.sort((a, b) => a.episode_key.localeCompare(b.episode_key));
  return { evaluated_at: new Date(now_ms).toISOString(), findings };
}

export function planRoleAttention({ evaluation, previous = {}, roleSeats = {}, now_ms = Date.now(), thresholds = DEFAULT_ROLE_ATTENTION_THRESHOLDS }) {
  const signaled = new Set(previous.signaled_episode_keys || []);
  const activeKeys = evaluation.findings.map((item) => item.episode_key);
  const pending = previous.pending_signal || null;
  const newlyBreached = pending
    ? evaluation.findings.filter((item) => pending.episode_keys.includes(item.episode_key))
    : evaluation.findings.filter((item) => !signaled.has(item.episode_key));
  const lastCompleted = roleSeats.attention?.last_completed_at || previous.last_completed_attention_pass_at || null;
  const patrolDue = !lastCompleted || now_ms - new Date(lastCompleted).getTime() >= thresholds.patrol_seconds * 1000;
  const signal = newlyBreached.length ? {
    signal_type: "stalled_work",
    episode_keys: newlyBreached.map((item) => item.episode_key),
    signal_key: pending?.signal_key || attentionSignalKey(newlyBreached.map((item) => item.episode_key)),
  } : patrolDue ? {
    signal_type: "patrol_due", episode_keys: [],
    signal_key: `patrol:${new Date(lastCompleted || 0).toISOString()}`,
  } : null;
  return { active_episode_keys: activeKeys, newly_breached: newlyBreached, patrol_due: patrolDue, signal };
}
