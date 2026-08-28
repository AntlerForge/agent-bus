export function deriveMacAvailability({ now, peerOnline, reportObservedAt, previous = null }) {
  const nowMs = Date.parse(now);
  const reportMs = Date.parse(reportObservedAt || "");
  const reportAgeMinutes = Number.isFinite(reportMs) ? (nowMs - reportMs) / 60000 : Number.POSITIVE_INFINITY;
  const reportFresh = reportAgeMinutes <= 30;
  const priorState = previous?.mac_state || null;
  const recentlyReturned = priorState === "offline"
    || (previous?.last_online_transition
      && (nowMs - Date.parse(previous.last_online_transition)) / 3600000 < 6);
  let macState;
  if (!peerOnline && !reportFresh) macState = "offline";
  else if (!peerOnline || !reportFresh || recentlyReturned) macState = "sporadic";
  else macState = "online";

  const lastSeen = reportFresh
    ? reportObservedAt
    : previous?.mac_last_seen || (Number.isFinite(reportMs) ? reportObservedAt : null);
  const transitionedOnline = priorState === "offline" && macState !== "offline";
  const transitionedOffline = priorState && priorState !== "offline" && macState === "offline";
  const offlineWindow = transitionedOnline ? {
    started_at: previous?.offline_since || previous?.updated_at || null,
    ended_at: now,
  } : previous?.offline_window || null;
  return {
    contract_version: "1.0",
    updated_at: now,
    mac_last_seen: lastSeen,
    mac_state: macState,
    evidence: { tailscale_online: Boolean(peerOnline), report_fresh: reportFresh, report_age_minutes: reportAgeMinutes },
    offline_since: transitionedOffline ? now : macState === "offline" ? previous?.offline_since || now : null,
    last_online_transition: transitionedOnline ? now : previous?.last_online_transition || null,
    offline_window: offlineWindow,
    reconciliation: transitionedOnline ? {
      id: `mac-return-${now.replace(/[^0-9]/g, "").slice(0, 14)}`,
      state: "pending",
      requested_at: now,
      offline_window: offlineWindow,
    } : previous?.reconciliation || null,
  };
}
