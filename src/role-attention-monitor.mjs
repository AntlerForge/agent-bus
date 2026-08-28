import { readJsonFile, writeJsonFileAtomic } from "./io.mjs";
import { planRoleAttention } from "./role-attention.mjs";

export async function executeRoleAttentionCycle({ evaluation, thresholds, client, snapshot_file, before_signal = null }) {
  const previous = await readJsonFile(snapshot_file, { schema_version: 1, signaled_episode_keys: [] });
  const roleSeats = await client.list();
  const plan = planRoleAttention({ evaluation, previous, roleSeats, thresholds });
  let pendingSignal = previous.pending_signal || null;
  if (plan.signal && !pendingSignal) pendingSignal = { ...plan.signal, created_at: evaluation.evaluated_at };
  let snapshot = {
    schema_version: 1, last_evaluated_at: evaluation.evaluated_at, last_success_at: previous.last_success_at || null,
    effective_thresholds: thresholds, active_findings: evaluation.findings,
    active_finding_counts: evaluation.findings.reduce((out, item) => ({ ...out, [item.type]: (out[item.type] || 0) + 1 }), {}),
    newly_breached_refs: plan.newly_breached.map((item) => ({ type: item.type, ref: item.ref, episode_key: item.episode_key })),
    signaled_episode_keys: previous.signaled_episode_keys || [], pending_signal: pendingSignal,
    last_signal: previous.last_signal || null,
    last_completed_attention_pass_at: roleSeats.attention?.last_completed_at || null,
    last_completed_attention_pass_seat_id: roleSeats.attention?.last_completed_seat_id || null,
    next_patrol_due_at: new Date(new Date(roleSeats.attention?.last_completed_at || 0).getTime() + thresholds.patrol_seconds * 1000).toISOString(),
  };
  await writeJsonFileAtomic(snapshot_file, snapshot);
  if (before_signal) await before_signal(snapshot);
  let disposition = "no_new_breach";
  if (pendingSignal) {
    const selected = evaluation.findings.filter((item) => pendingSignal.episode_keys.includes(item.episode_key));
    const counts = selected.reduce((out, item) => ({ ...out, [item.type]: (out[item.type] || 0) + 1 }), {});
    const reason = pendingSignal.signal_type === "patrol_due"
      ? "Routine Estate Operations Manager patrol: reconcile stalled work, automation health, ownership and closure traces within the role charter."
      : `Estate attention monitor found ${Object.entries(counts).map(([type, count]) => `${count} ${type.replaceAll("_", " ")}`).join(", ")} newly breached. Work the operations queue and route each item without notifying Tony merely because this signal fired.`;
    const signal = await client.signal({ signal_type: pendingSignal.signal_type, signal_key: pendingSignal.signal_key, episode_keys: pendingSignal.episode_keys, reason, source_ref: "agent-bus:role-attention-monitor", detected_at: evaluation.evaluated_at });
    disposition = signal.disposition;
    snapshot.signaled_episode_keys = [...new Set([...snapshot.signaled_episode_keys, ...pendingSignal.episode_keys])];
    snapshot.pending_signal = null;
    snapshot.last_signal = { signal_key: pendingSignal.signal_key, disposition, created_at: evaluation.evaluated_at };
  }
  snapshot.last_success_at = new Date().toISOString();
  await writeJsonFileAtomic(snapshot_file, snapshot);
  return { ...evaluation, newly_breached: plan.newly_breached.length, disposition };
}
