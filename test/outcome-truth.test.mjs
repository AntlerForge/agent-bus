import test from "node:test";
import assert from "node:assert/strict";
import { borgArchiveAgeMinutes, borgScriptCoversLegacySources, synthesisOutcomeIsClean } from "../src/outcome-truth/probes.mjs";
import fs from "node:fs/promises";
import { applyEvaluation, cardId, loadMatrix } from "../src/outcome-truth/core.mjs";

const matrix = await loadMatrix("config/outcome-truth-matrix.v1.yaml");
const july = JSON.parse(await fs.readFile("test/fixtures/outcome-july-2026.json", "utf8"));

test("July replay catches named failures and ignores van and HA noise", () => {
  const out = applyEvaluation({ matrix, snapshot: july, now: "2026-07-18T12:00:00Z", shadowStartedAt: "2026-07-19T00:00:00Z" });
  const ids = out.results.filter((r) => r.state === "fail").map((r) => r.id);
  assert.ok(ids.includes("kv-doctor-overall"));
  assert.ok(matrix.checks.some((check) => check.id === "mac-repo-risk-sweep-freshness"));
  assert.ok(matrix.checks.some((check) => check.id === "mac-retired-local-bus-write"));
  assert.ok(matrix.checks.some((check) => check.id === "kv-daily-synthesis-run-freshness"));
  assert.ok(matrix.checks.some((check) => check.id === "estate-steward-freshness"));
  assert.ok(ids.includes("a6-legacy-rsync-semantic-outcome"));
  for (const id of ["mac-launchagent-share-mount", "mac-launchagent-runtime-check", "mac-launchagent-developer-mirrors", "mac-launchagent-project-store"]) assert.ok(ids.includes(id));
  assert.equal(ids.some((id) => /spaniel|home.assistant|entity/.test(id)), false);
  assert.equal(Object.keys(out.cards).length, 8);
});

test("cards deduplicate and close only after semantic recovery", () => {
  const first = applyEvaluation({ matrix, snapshot: july, now: "2026-07-18T12:00:00Z", shadowStartedAt: "2026-07-18T12:00:00Z" });
  const repeated = applyEvaluation({ matrix, snapshot: july, previous: first.cards, now: "2026-07-18T12:15:00Z", shadowStartedAt: "2026-07-18T12:00:00Z" });
  assert.equal(repeated.transitions.length, 0);
  assert.equal(repeated.cards[cardId(matrix.matrix_id,"kv-doctor-overall")].occurrences, 2);
  const healthy = structuredClone(july);
  healthy.doctor.status = "pass"; healthy.borg.healthy = true; healthy.borg.full_legacy_coverage = true; healthy.mac.mount_present = true; healthy.synthesis.latest_clean = true;
  for (const contract of Object.values(healthy.mac.contracts)) contract.healthy = true;
  healthy.mac.local_bus.unexpected_write_count = 0;
  for (const item of Object.values(healthy.mac.launchagents)) item.age_minutes = 1;
  const recovered = applyEvaluation({ matrix, snapshot: healthy, previous: repeated.cards, now: "2026-07-18T12:30:00Z", shadowStartedAt: "2026-07-18T12:00:00Z" });
  assert.equal(recovered.transitions.filter((t) => t.type === "recovered").length, 8);
  assert.equal(Object.values(recovered.cards).every((c) => c.status === "closed"), true);
  assert.equal(recovered.cards[cardId(matrix.matrix_id,"kv-doctor-overall")].actual, "pass");
  assert.equal(recovered.transitions.every((t) => !t.notify), true);
});

test("sentinel and deadman dispatch to Estate Steward agents, never directly to HA", async () => {
  const sources = await Promise.all(["scripts/outcome-truth-sentinel.mjs", "scripts/outcome-truth-deadman.mjs"].map((f) => fs.readFile(f,"utf8")));
  assert.equal(sources.join("\n").includes("ha-notify-tony.mjs"), false);
  assert.match(sources[0], /dispatchOutcomeFailure/);
  assert.match(sources[0], /steward_dispatched_at/);
  assert.match(sources[1], /dispatchSentinelDeadman/);
});

test("an induced sandbox fault opens once and semantic recovery closes it", () => {
  const healthy = structuredClone(july);
  healthy.doctor.status = "pass"; healthy.borg.healthy = true; healthy.borg.full_legacy_coverage = true; healthy.mac.mount_present = true; healthy.synthesis.latest_clean = true;
  for (const contract of Object.values(healthy.mac.contracts)) contract.healthy = true;
  healthy.mac.local_bus.unexpected_write_count = 0;
  for (const item of Object.values(healthy.mac.launchagents)) item.age_minutes = 1;
  const baseline = applyEvaluation({ matrix, snapshot: healthy, now: "2026-07-18T12:00:00Z", shadowStartedAt: "2026-07-18T11:00:00Z" });
  const fault = structuredClone(healthy); fault.sandbox.ok = false;
  const failed = applyEvaluation({ matrix, snapshot: fault, previous: baseline.cards, now: "2026-07-18T12:15:00Z", shadowStartedAt: "2026-07-18T11:00:00Z" });
  assert.deepEqual(failed.transitions.map((t) => [t.type, t.card.check_id, t.notify]), [["opened", "sentinel-sandbox-contract", false]]);
  const repeated = applyEvaluation({ matrix, snapshot: fault, previous: failed.cards, now: "2026-07-18T12:45:00Z", shadowStartedAt: "2026-07-18T11:00:00Z" });
  assert.deepEqual(repeated.transitions.map((t) => [t.type, t.card.check_id, t.notify]), [["escalated", "sentinel-sandbox-contract", true]]);
  const recovered = applyEvaluation({ matrix, snapshot: healthy, previous: repeated.cards, now: "2026-07-18T13:00:00Z", shadowStartedAt: "2026-07-18T11:00:00Z" });
  assert.deepEqual(recovered.transitions.map((t) => [t.type, t.card.check_id, t.notify]), [["recovered", "sentinel-sandbox-contract", true]]);
});

test("normal Mac sleep suppresses freshness failures without masking an awake failure", () => {
  const asleep = structuredClone(july);
  for (const contract of Object.values(asleep.mac.contracts)) contract.healthy = true;
  const asleepResult = applyEvaluation({ matrix, snapshot: asleep, now: "2026-07-20T02:30:00Z", shadowStartedAt: "2026-07-18T00:00:00Z" });
  assert.equal(asleepResult.results.filter((result) => result.id.startsWith("mac-") && result.state === "fail").length, 0);
  asleep.mac.contracts.reporter.healthy = false;
  const awakeFailure = applyEvaluation({ matrix, snapshot: asleep, now: "2026-07-20T09:00:00Z", shadowStartedAt: "2026-07-18T00:00:00Z" });
  assert.equal(awakeFailure.results.find((result) => result.id === "mac-reporter-freshness").state, "fail");
});

test("synthesis freshness respects the Tuesday-Sunday producer schedule", () => {
  const stale = structuredClone(july);
  stale.synthesis.latest_run_age_minutes = 1811;
  const monday = applyEvaluation({
    matrix, snapshot: stale, now: "2026-08-17T11:12:00Z", shadowStartedAt: "2026-08-16T00:00:00Z",
  });
  const mondayResult = monday.results.find((result) => result.id === "kv-daily-synthesis-run-freshness");
  assert.equal(mondayResult.state, "pass");
  assert.equal(mondayResult.suspended, true);
  assert.equal(mondayResult.suspension_reason, "producer_schedule_quiet");

  const tuesdayGrace = applyEvaluation({
    matrix, snapshot: stale, now: "2026-08-18T05:29:00Z", shadowStartedAt: "2026-08-16T00:00:00Z",
  });
  assert.equal(tuesdayGrace.results.find((result) => result.id === "kv-daily-synthesis-run-freshness").state, "pass");

  const tuesdayMissed = applyEvaluation({
    matrix, snapshot: stale, now: "2026-08-18T05:31:00Z", shadowStartedAt: "2026-08-16T00:00:00Z",
  });
  assert.equal(tuesdayMissed.results.find((result) => result.id === "kv-daily-synthesis-run-freshness").state, "fail");
});
test("Borg legacy coverage reads Bash source arrays without punctuation false negatives", () => {
  assert.equal(borgScriptCoversLegacySources("sources=(/share /srv /etc/kv)"), true);
  assert.equal(borgScriptCoversLegacySources("sources=(\n  '/share'\n  \"/srv\"\n)"), true);
  assert.equal(borgScriptCoversLegacySources("sources=(/srv /etc/kv)"), false);
  assert.equal(borgScriptCoversLegacySources("echo /share /srv"), false);
});

test("Borg archive freshness survives missing systemd timestamps after reboot", () => {
  const now = Date.parse("2026-08-17T14:10:00Z");
  assert.equal(
    borgArchiveAgeMinutes({ archives: [{ start: "2026-08-17T14:05:38.000000" }] }, now),
    4 + 22 / 60,
  );
  assert.equal(borgArchiveAgeMinutes({ archives: [] }, now), Number.POSITIVE_INFINITY);
  assert.equal(borgArchiveAgeMinutes({ archives: [{ start: "invalid" }] }, now), Number.POSITIVE_INFINITY);
});

test("synthesis treats explicitly non-blocking warnings as semantically clean", () => {
  const healthyWarning = {
    event: "run_warning",
    metadata: {
      adapter_health: { required: "ok" },
      dashboard: { rebuilt: true, health: { healthz: 200, kv_data: 200, usage: 200, version: 200 } },
      email_triage: { fresh: true, status: "completed" },
      funnel: { auto_errors: 0 },
      maintenance: { doctor: "warn; no hard failures" },
      warnings: ["Review-gated work remains."],
    },
  };
  assert.equal(synthesisOutcomeIsClean(healthyWarning), true);
  assert.equal(synthesisOutcomeIsClean({ ...healthyWarning, metadata: { ...healthyWarning.metadata, maintenance: { doctor: "failed: validation" } } }), false);
  assert.equal(synthesisOutcomeIsClean({ ...healthyWarning, metadata: { ...healthyWarning.metadata, funnel: { auto_errors: 1 } } }), false);
  assert.equal(synthesisOutcomeIsClean({ event: "run_failed", metadata: healthyWarning.metadata }), false);
});

test("synthesis accepts the current flattened healthy run metadata", () => {
  const currentRun = {
    event: "run_warning",
    metadata: {
      adapter_health: "required adapters healthy",
      dashboard_health: { healthz: 200, kv_data: 200, usage: 200, version: 200 },
      email_triage_run_id: "f1bb35be74d548d881e5222131c77592",
      email_triage_fallback: false,
      auto_errors: 0,
      doctor: "warn-no-hard-failure",
      warnings: [
        "Doctor non-blocking warnings: validation, stale references and review proposals.",
        "Canonical Day Board remains stale.",
      ],
    },
  };
  assert.equal(synthesisOutcomeIsClean(currentRun), true);
  assert.equal(synthesisOutcomeIsClean({ ...currentRun, metadata: { ...currentRun.metadata, auto_errors: 1 } }), false);
  assert.equal(synthesisOutcomeIsClean({ ...currentRun, metadata: { ...currentRun.metadata, doctor: "failed: hard validation" } }), false);
});

test("synthesis accepts the current scalar status metadata with advisory doctor warning", () => {
  const currentRun = {
    event: "run_warning",
    metadata: {
      adapters_status: "ok",
      dashboard_health: "ok",
      email_triage_run_id: "082fd07c7bb2412eac5547e164302f65",
      email_triage_status: "completed",
      funnel: { auto_errors: 0 },
      warnings: ["KV Doctor WARN: existing non-blocking validation and deployment findings."],
    },
  };
  assert.equal(synthesisOutcomeIsClean(currentRun), true);
  assert.equal(synthesisOutcomeIsClean({ ...currentRun, metadata: {
    ...currentRun.metadata,
    warnings: ["KV Doctor failed: hard validation failure."],
  } }), false);
});

test("synthesis does not retroactively repair an unverified doctor result", () => {
  const currentRun = {
    event: "run_warning",
    metadata: {
      dashboard: "rebuilt; health/version/kv-data/api-usage healthy",
      email_triage_run_id: "8e259ca8c1b1414c90fb5cd5056adc09",
      email_triage_status: "completed",
      funnel: { auto_errors: 0 },
      maintenance: { doctor: "unverified: timed out" },
      source_adapters: { required_probe: "ok" },
      warnings: ["Doctor timed out before a current report"],
    },
  };
  assert.equal(synthesisOutcomeIsClean(currentRun), false);
  assert.equal(synthesisOutcomeIsClean(currentRun, { doctorStatus: "pass" }), false);
  assert.equal(synthesisOutcomeIsClean({ ...currentRun, metadata: {
    ...currentRun.metadata,
    maintenance: { doctor: "failed: hard validation" },
  } }, { doctorStatus: "pass" }), false);
});

test("synthesis accepts a completed email reconciliation whose dashboard warning was repaired later in the run", () => {
  const currentRun = {
    event: "run_warning",
    metadata: {
      source_adapters_status: "ok",
      dashboard: "rebuilt and healthy",
      doctor: "warn: 0 errors, 103 existing warnings",
      email_triage_run_id: "0bbb31d366f8493cb34b81df09f6efd2",
      email_triage_status: "warning",
      funnel: { auto_errors: 0 },
      warnings: [
        "SpanielBus dashboard cache refresh timed out; current vehicle telemetry was not refreshed.",
        "Automation catalog cannot verify Mac-local scheduler files from A6.",
      ],
    },
  };
  assert.equal(synthesisOutcomeIsClean(currentRun, { doctorStatus: "fail" }), true);
  assert.equal(synthesisOutcomeIsClean({ ...currentRun, metadata: {
    ...currentRun.metadata,
    dashboard: "rebuild failed",
  } }, { doctorStatus: "pass" }), false);
});

test("synthesis accepts HTTP 200 dashboard evidence and zero hard doctor failures", () => {
  const currentRun = {
    event: "run_warning",
    metadata: {
      source_adapters_status: "ok",
      dashboard: "rebuilt; healthz/version/kv-data.json/api/usage HTTP 200",
      email_triage: { fresh: true, status: "warning" },
      funnel: { auto_errors: 0 },
      maintenance: { doctor: "0 hard failures; 103 existing non-blocking warnings" },
      warnings: ["Automation catalog cannot verify Mac-local scheduler files from A6."],
    },
  };
  assert.equal(synthesisOutcomeIsClean(currentRun), true);
  assert.equal(synthesisOutcomeIsClean({ ...currentRun, metadata: {
    ...currentRun.metadata,
    dashboard: "healthz HTTP 500; rebuild failed",
  } }), false);
  assert.equal(synthesisOutcomeIsClean({ ...currentRun, metadata: {
    ...currentRun.metadata,
    maintenance: { doctor: "1 hard failure remains" },
  } }), false);
});

test("synthesis accepts a successful ordinary-mail fallback when scheduled triage is stale", () => {
  const fallbackRun = {
    event: "run_warning",
    metadata: {
      adapter_health: "all required source adapters ok",
      dashboard_health: "healthy",
      doctor_status: "warn_no_hard_failure",
      funnel: { auto_errors: 0 },
      ordinary_mail_fallback: true,
      ordinary_mail_scanned: 37,
      warnings: ["kv-email-triage stale; 26-hour fallback used"],
    },
  };
  assert.equal(synthesisOutcomeIsClean(fallbackRun), true);
  assert.equal(synthesisOutcomeIsClean({ ...fallbackRun, metadata: {
    ...fallbackRun.metadata,
    ordinary_mail_scanned: 0,
  } }), false);
});

test("synthesis accepts the authoritative ordinary-mail reconciliation shape", () => {
  const currentRun = {
    event: "run_warning",
    metadata: {
      adapter_health: "all required source adapters ok",
      dashboard_health: { healthz: 200, kv_data: 200, usage: 200, version: 200 },
      doctor_status: "warn_no_hard_failure",
      funnel: { auto_errors: 0 },
      ordinary_mail_reconciliation: {
        hours: 6,
        inbox: 1,
        sent: 0,
        tasks_created: [],
        tasks_updated: [],
        tasks_completed: [],
        calendar_events_created: [],
      },
      warnings: ["House climate sensor source unreachable: No route to host."],
    },
  };
  assert.equal(synthesisOutcomeIsClean(currentRun), true);
  assert.equal(synthesisOutcomeIsClean({ ...currentRun, metadata: {
    ...currentRun.metadata,
    ordinary_mail_reconciliation: { ...currentRun.metadata.ordinary_mail_reconciliation, tasks_updated: null },
  } }), false);
});
