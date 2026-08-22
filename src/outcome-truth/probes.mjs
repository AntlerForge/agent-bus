export function borgScriptCoversLegacySources(script) {
  const sourceAssignment = script.match(/sources\s*=\s*\(([^)]*)\)/s)?.[1] || "";
  const declared = new Set(sourceAssignment.match(/\/(?:[^\s'"\\)]+|\\.)+/g) || []);
  return declared.has("/share") && declared.has("/srv");
}

export function borgArchiveAgeMinutes(payload, nowMs = Date.now()) {
  const archive = payload?.archives?.[0];
  const rawTimestamp = archive?.start || archive?.time;
  if (typeof rawTimestamp !== "string" || rawTimestamp.length === 0) return Number.POSITIVE_INFINITY;
  const timestamp = /(?:Z|[+-]\d\d:\d\d)$/i.test(rawTimestamp) ? rawTimestamp : `${rawTimestamp}Z`;
  const archiveMs = Date.parse(timestamp);
  return Number.isFinite(archiveMs) ? (nowMs - archiveMs) / 60000 : Number.POSITIVE_INFINITY;
}

export function synthesisOutcomeIsClean(outcome, context = {}) {
  if (outcome?.event === "run_completed") return true;
  if (outcome?.event !== "run_warning") return false;
  const metadata = outcome.metadata || {};
  const adapterHealth = metadata.adapter_health;
  const adaptersHealthy = typeof adapterHealth === "string"
    ? /healthy|\bok\b/i.test(adapterHealth)
    : adapterHealth?.required === "ok"
      || /healthy|\bok\b/i.test(String(metadata.adapters_status || ""))
      || /healthy|\bok\b/i.test(String(metadata.source_adapters_status || ""))
      || /healthy|\bok\b/i.test(String(metadata.source_adapters?.required_probe || ""));
  const dashboard = metadata.dashboard || {};
  const dashboardHealth = typeof dashboard === "string"
    ? dashboard
    : dashboard.health || metadata.dashboard_health || {};
  const dashboardHealthy = typeof dashboardHealth === "string"
    ? /healthy|\bok\b/i.test(dashboardHealth) && !/failed|unhealthy/i.test(dashboardHealth)
    : Object.keys(dashboardHealth).length > 0
      && Object.values(dashboardHealth).every((value) => value === 200 || value === "ok" || value === true)
      && (dashboard.rebuilt === undefined || dashboard.rebuilt === true);
  const emailHealthy = metadata.email_triage
    ? metadata.email_triage.fresh === true && metadata.email_triage.status === "completed"
    : typeof metadata.email_triage_run_id === "string" && metadata.email_triage_run_id.length > 0
      && (metadata.email_triage_status === undefined
        || metadata.email_triage_status === "completed"
        || (metadata.email_triage_status === "warning" && dashboardHealthy));
  const funnelErrors = metadata.funnel?.auto_errors ?? metadata.auto_errors;
  const funnelHealthy = funnelErrors === 0;
  const doctorWarnings = (metadata.warnings || []).filter((warning) => /doctor/i.test(String(warning))).join(" ");
  const doctor = String(metadata.maintenance?.doctor || metadata.doctor || doctorWarnings).toLowerCase();
  const doctorHasHardFailure = /(^|\b)failed\b|hard failures remain/.test(doctor);
  const doctorHealthy = !doctorHasHardFailure
    && (/no.hard.failures?|warn.*non.blocking|pass|healthy/.test(doctor) || context.doctorStatus === "pass");
  return adaptersHealthy && dashboardHealthy && emailHealthy && funnelHealthy && doctorHealthy;
}
