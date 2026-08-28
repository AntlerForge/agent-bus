export function roleAttentionHealthFaults({ snapshot, seats, now_ms = Date.now(), max_age_seconds = 900 }) {
  const faults = [];
  const maxAgeMs = max_age_seconds * 1000;
  if (!snapshot?.last_success_at || now_ms - new Date(snapshot.last_success_at).getTime() > maxAgeMs) faults.push("attention monitor snapshot is stale");
  if (!seats?.worker?.last_seen_at || now_ms - new Date(seats.worker.last_seen_at).getTime() > maxAgeMs) faults.push("Mac role-wake worker heartbeat is stale");
  return faults;
}
