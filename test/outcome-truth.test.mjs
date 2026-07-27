import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { applyEvaluation, cardId, loadMatrix, probeCardId, scheduledFreshnessHealthy, synthesisSemanticallyClean } from "../src/outcome-truth/core.mjs";

const matrix = await loadMatrix("config/outcome-truth-matrix.v1.yaml");
const july = JSON.parse(await fs.readFile("test/fixtures/outcome-july-2026.json", "utf8"));

test("July replay catches named failures and ignores van and HA noise", () => {
  const out = applyEvaluation({ matrix, snapshot: july, now: "2026-07-18T12:00:00Z", shadowStartedAt: "2026-07-19T00:00:00Z" });
  const ids = out.results.filter((r) => r.state === "fail").map((r) => r.id);
  assert.ok(ids.includes("kv-doctor-overall"));
  assert.ok(matrix.checks.some((check) => check.id === "mac-repo-risk-sweep-freshness"));
  assert.ok(matrix.checks.some((check) => check.id === "mac-retired-local-bus-write"));
  assert.ok(matrix.checks.some((check) => check.id === "kv-daily-synthesis-run-freshness"));
  assert.ok(matrix.checks.some((check) => check.id === "grist-workbench-projection-freshness"));
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

test("sentinel emits only ALERT transition requests and daily INFO is separate", async () => {
  const sources = await Promise.all(["scripts/outcome-truth-sentinel.mjs", "scripts/outcome-truth-deadman.mjs"].map((f) => fs.readFile(f,"utf8")));
  assert.equal(sources.join("\n").includes('"--class", "APPROVAL"'), false);
  assert.match(sources[0], /"--class", "INFO"/);
  assert.match(sources[1], /"--class", "ALERT"/);
  assert.equal(sources.join("\n").includes('"--title"'), false);
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

test("missing observations open a distinct immediate probe-fault card, not an outcome failure", () => {
  const healthy = structuredClone(july);
  healthy.doctor.status = "pass";
  healthy.borg.healthy = null;
  healthy.borg.full_legacy_coverage = true;
  healthy.synthesis.latest_clean = true;
  for (const contract of Object.values(healthy.mac.contracts)) contract.healthy = true;
  const blind = applyEvaluation({ matrix, snapshot: healthy, now: "2026-07-23T10:34:00Z", shadowStartedAt: "2026-07-18T00:00:00Z" });
  assert.equal(blind.results.find((result) => result.id === "a6-borg-hourly-freshness").state, "probe_fault");
  assert.equal(blind.cards[cardId(matrix.matrix_id, "a6-borg-hourly-freshness")], undefined);
  const probe = blind.cards[probeCardId(matrix.matrix_id, "a6-borg-hourly-freshness")];
  assert.equal(probe.card_class, "probe_fault");
  assert.deepEqual(blind.transitions.map((t) => [t.type, t.notify]), [["probe_fault_opened", true]]);
  healthy.borg.healthy = true;
  const visible = applyEvaluation({ matrix, snapshot: healthy, previous: blind.cards, now: "2026-07-23T10:49:00Z", shadowStartedAt: "2026-07-18T00:00:00Z" });
  assert.equal(visible.cards[probe.card_id].status, "closed");
  assert.deepEqual(visible.transitions.map((t) => [t.type, t.notify]), [["probe_fault_recovered", true]]);
});

test("synthesis semantic clean ignores declared non-blocking warnings but not hard failures", () => {
  const warning = {
    event: "run_warning",
    metadata: {
      intake: { required_adapter_status: "ok", triage: { auto_errors: 0 } },
      dashboard: { build: "ok", healthz: "ok" },
      maintenance: { doctor_hard_failures: 0 },
    },
  };
  assert.equal(synthesisSemanticallyClean(warning), true);
  warning.metadata.maintenance.doctor_hard_failures = 1;
  assert.equal(synthesisSemanticallyClean(warning), false);
  assert.equal(synthesisSemanticallyClean({ event: "run_failed" }), false);
});

test("shadow probe faults remain recorded without a later recovery notification", () => {
  const snapshot = structuredClone(july);
  snapshot.borg.healthy = null;
  const blind = applyEvaluation({ matrix, snapshot, now: "2026-07-23T10:00:00Z", shadowStartedAt: "2026-07-24T00:00:00Z" });
  const probe = blind.cards[probeCardId(matrix.matrix_id, "a6-borg-hourly-freshness")];
  assert.equal(probe.notification_state, "suppressed");
  assert.equal(blind.transitions.find((t) => t.card.card_id === probe.card_id).notify, false);
  snapshot.borg.healthy = true;
  const recovered = applyEvaluation({ matrix, snapshot, previous: blind.cards, now: "2026-07-23T10:15:00Z", shadowStartedAt: "2026-07-24T00:00:00Z" });
  assert.equal(recovered.transitions.find((t) => t.card.card_id === probe.card_id).notify, false);
});

test("Grist freshness follows its producer calendar without masking daytime failure", () => {
  const base = {
    statusOk: true,
    integrityOk: true,
    ageMinutes: 36,
    firstDueUtc: "07:00",
    lastDueUtc: "22:45",
    graceMinutes: 30,
  };
  assert.equal(scheduledFreshnessHealthy({ ...base, now: new Date("2026-07-24T23:21:13Z") }), true);
  assert.equal(scheduledFreshnessHealthy({ ...base, now: new Date("2026-07-25T07:15:00Z") }), true);
  assert.equal(scheduledFreshnessHealthy({ ...base, now: new Date("2026-07-25T12:00:00Z") }), false);
  assert.equal(scheduledFreshnessHealthy({ ...base, integrityOk: false, now: new Date("2026-07-24T23:21:13Z") }), false);
});

test("holding-pen beacon opens above 25 and closes only after a later bounded count", () => {
  const healthy = structuredClone(july);
  healthy.holding_pen.item_count = 26;
  const opened = applyEvaluation({ matrix, snapshot: healthy, now: "2026-07-27T12:00:00Z", shadowStartedAt: "2026-07-26T00:00:00Z" });
  assert.equal(opened.results.find((result) => result.id === "kv-holding-pen-size").state, "fail");
  healthy.holding_pen.item_count = 25;
  const closed = applyEvaluation({ matrix, snapshot: healthy, previous: opened.cards, now: "2026-07-27T12:15:00Z", shadowStartedAt: "2026-07-26T00:00:00Z" });
  assert.equal(closed.cards[cardId(matrix.matrix_id, "kv-holding-pen-size")].status, "closed");
});
