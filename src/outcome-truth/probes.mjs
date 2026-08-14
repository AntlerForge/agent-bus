export function borgScriptCoversLegacySources(script) {
  const sourceAssignment = script.match(/sources\s*=\s*\(([^)]*)\)/s)?.[1] || "";
  const declared = new Set(sourceAssignment.match(/\/(?:[^\s'"\\)]+|\\.)+/g) || []);
  return declared.has("/share") && declared.has("/srv");
}

export function synthesisOutcomeIsClean(outcome) {
  if (outcome?.event === "run_completed") return true;
  if (outcome?.event !== "run_warning") return false;
  const metadata = outcome.metadata || {};
  const adapterHealth = metadata.adapter_health;
  const adaptersHealthy = typeof adapterHealth === "string"
    ? /healthy|\bok\b/i.test(adapterHealth)
    : adapterHealth?.required === "ok";
  const dashboard = metadata.dashboard || {};
  const dashboardHealthy = dashboard.rebuilt === true
    && Object.values(dashboard.health || {}).every((value) => value === 200 || value === "ok" || value === true);
  const emailHealthy = metadata.email_triage?.fresh === true
    && metadata.email_triage?.status === "completed";
  const funnelHealthy = metadata.funnel?.auto_errors === 0;
  const doctor = String(metadata.maintenance?.doctor || "").toLowerCase();
  const doctorHealthy = !/(^|\b)failed\b|hard failures remain/.test(doctor)
    && (/no hard failures|warn.nonblocking|pass|healthy/.test(doctor));
  return adaptersHealthy && dashboardHealthy && emailHealthy && funnelHealthy && doctorHealthy;
}
