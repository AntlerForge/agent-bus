import test from "node:test";
import assert from "node:assert/strict";
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
  healthy.doctor.status = "pass"; healthy.borg.full_legacy_coverage = true; healthy.mac.mount_present = true; healthy.synthesis.latest_clean = true;
  for (const contract of Object.values(healthy.mac.contracts)) contract.healthy = true;
  healthy.mac.local_bus.unexpected_write_count = 0;
  for (const item of Object.values(healthy.mac.launchagents)) item.age_minutes = 1;
  const recovered = applyEvaluation({ matrix, snapshot: healthy, previous: repeated.cards, now: "2026-07-18T12:30:00Z", shadowStartedAt: "2026-07-18T12:00:00Z" });
  assert.equal(recovered.transitions.filter((t) => t.type === "recovered").length, 8);
  assert.equal(Object.values(recovered.cards).every((c) => c.status === "closed"), true);
  assert.equal(recovered.cards[cardId(matrix.matrix_id,"kv-doctor-overall")].actual, "pass");
  assert.equal(recovered.transitions.every((t) => t.notify), true);
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
  healthy.doctor.status = "pass"; healthy.borg.full_legacy_coverage = true; healthy.mac.mount_present = true; healthy.synthesis.latest_clean = true;
  for (const contract of Object.values(healthy.mac.contracts)) contract.healthy = true;
  healthy.mac.local_bus.unexpected_write_count = 0;
  for (const item of Object.values(healthy.mac.launchagents)) item.age_minutes = 1;
  const baseline = applyEvaluation({ matrix, snapshot: healthy, now: "2026-07-18T12:00:00Z", shadowStartedAt: "2026-07-18T11:00:00Z" });
  const fault = structuredClone(healthy); fault.sandbox.ok = false;
  const failed = applyEvaluation({ matrix, snapshot: fault, previous: baseline.cards, now: "2026-07-18T12:15:00Z", shadowStartedAt: "2026-07-18T11:00:00Z" });
  assert.deepEqual(failed.transitions.map((t) => [t.type, t.card.check_id, t.notify]), [["opened", "sentinel-sandbox-contract", true]]);
  const repeated = applyEvaluation({ matrix, snapshot: fault, previous: failed.cards, now: "2026-07-18T12:30:00Z", shadowStartedAt: "2026-07-18T11:00:00Z" });
  assert.equal(repeated.transitions.length, 0);
  const recovered = applyEvaluation({ matrix, snapshot: healthy, previous: repeated.cards, now: "2026-07-18T12:45:00Z", shadowStartedAt: "2026-07-18T11:00:00Z" });
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
