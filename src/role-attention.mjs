import { createHash } from "node:crypto";
import { listAgents } from "./agents.mjs";
import { readInbox } from "./mailbox.mjs";
import { listWorkItems } from "./work-ledger/store.mjs";

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

function keyFor(items) {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex").slice(0, 24);
}

export async function evaluateRoleAttention({ now_ms = Date.now(), thresholds = DEFAULT_ROLE_ATTENTION_THRESHOLDS } = {}, root) {
  const findings = [];
  for (const agent of await listAgents(root)) {
    for (const message of await readInbox({ agent: agent.agent_id }, root)) {
      if (message.requires_response && ageSeconds(message.created, now_ms) >= thresholds.unread_response_seconds) {
        findings.push({ type: "unread_response", ref: message.id, owner: agent.agent_id, age_seconds: Math.floor(ageSeconds(message.created, now_ms)) });
      }
    }
  }
  const items = await listWorkItems({}, root);
  for (const item of items) {
    for (const run of item.runs || []) {
      if (["waiting_input", "blocked"].includes(run.status) && ageSeconds(run.updated_at, now_ms) >= thresholds.waiting_run_seconds) {
        findings.push({ type: "waiting_run", ref: run.run_id, work_item_id: item.work_item_id, age_seconds: Math.floor(ageSeconds(run.updated_at, now_ms)) });
      }
    }
    if (item.status === "review" && ageSeconds(item.updated_at, now_ms) >= thresholds.pending_review_seconds) {
      findings.push({ type: "pending_review", ref: item.work_item_id, age_seconds: Math.floor(ageSeconds(item.updated_at, now_ms)) });
    }
  }
  findings.sort((a, b) => `${a.type}:${a.ref}`.localeCompare(`${b.type}:${b.ref}`));
  return { evaluated_at: new Date(now_ms).toISOString(), findings, signal_key: `stalled:${keyFor(findings.map(({ type, ref }) => ({ type, ref })))}` };
}
