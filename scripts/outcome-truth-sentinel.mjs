#!/usr/bin/env node
import fs from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { applyEvaluation, loadCards, loadMatrix, saveCards } from "../src/outcome-truth/core.mjs";
import { dispatchOutcomeFailure } from "../src/estate-steward/dispatch.mjs";
import { borgArchiveAgeMinutes, borgScriptCoversLegacySources, synthesisOutcomeIsClean } from "../src/outcome-truth/probes.mjs";
import { deriveMacAvailability } from "../src/outcome-truth/mac-availability.mjs";
import { writeJsonFileAtomic } from "../src/io.mjs";

const execFile = promisify(execFileCb);
const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => v.startsWith("--") ? [v.slice(2), a[i + 1]] : null).filter(Boolean));
const matrixFile = args.matrix || process.env.OUTCOME_MATRIX || "config/outcome-truth-matrix.v1.yaml";
const stateDir = process.env.OUTCOME_STATE_DIR || "/srv/projects/Personal/agent-bus/runtime/outcome-truth";
const cardsFile = `${stateDir}/cards.json`;
const snapshotFile = args.snapshot || process.env.OUTCOME_SNAPSHOT;
const now = process.env.OUTCOME_NOW || new Date().toISOString();
const runtimeRoot = process.env.AGENT_BUS_RUNTIME || "/srv/projects/Personal/agent-bus/runtime";
const macAvailabilityFile = process.env.MAC_AVAILABILITY_FILE || `${stateDir}/mac-availability.json`;
const macReconciliationFile = process.env.MAC_RECONCILIATION_FILE || `${stateDir}/mac-reconciliation.json`;
const macReconciliationLedger = process.env.MAC_RECONCILIATION_LEDGER || `${stateDir}/mac-reconciliation.jsonl`;

async function readJsonOrNull(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function collect() {
  if (snapshotFile) return JSON.parse(await fs.readFile(snapshotFile, "utf8"));
  const doctor = JSON.parse(await fs.readFile("/srv/kv/vault/dashboard/doctor.json", "utf8"));
  const borgScript = await fs.readFile("/usr/local/sbin/antler-a6-borg-backup.sh", "utf8");
  const { stdout: borgOut } = await execFile("systemctl", ["show", "antler-a6-borg-backup.service", "-p", "ActiveState", "-p", "ExecMainStartTimestamp", "-p", "ExecMainExitTimestamp", "-p", "Result"]);
  const borgState = Object.fromEntries(borgOut.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
  const borgRunning = ["active", "activating"].includes(borgState.ActiveState);
  const borgTime = Date.parse(borgRunning ? borgState.ExecMainStartTimestamp : borgState.ExecMainExitTimestamp);
  let borgAgeMinutes = (Date.now() - borgTime) / 60000;
  let borgFreshnessSource = borgRunning ? "service_start" : "service_exit";
  if (!borgRunning) {
    try {
      const { stdout: borgListOut } = await execFile(
        "sudo",
        ["-n", "borg", "list", "--json", "--last", "1", "/mnt/backup/borg/a6-primary"],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      const archiveAgeMinutes = borgArchiveAgeMinutes(JSON.parse(borgListOut));
      if (Number.isFinite(archiveAgeMinutes)) {
        borgAgeMinutes = archiveAgeMinutes;
        borgFreshnessSource = "latest_archive";
      }
    } catch {}
  }
  const macFile = process.env.OUTCOME_MAC_SNAPSHOT || `${stateDir}/mac-snapshot.json`;
  const macOut = await fs.readFile(macFile, "utf8");
  let estateSteward = { healthy: false, age_minutes: Number.POSITIVE_INFINITY, contract_version: null };
  try {
    const estateSnapshot = JSON.parse(await fs.readFile(
      process.env.ESTATE_STEWARD_SNAPSHOT || "/srv/projects/Personal/estate-monitor/runtime/status.json",
      "utf8",
    ));
    const estateAgeMinutes = (Date.now() - Date.parse(estateSnapshot.generatedAt)) / 60000;
    estateSteward = {
      healthy: estateSnapshot.contractVersion === "2.0" && Number.isFinite(estateAgeMinutes) && estateAgeMinutes <= 5,
      age_minutes: estateAgeMinutes,
      contract_version: estateSnapshot.contractVersion || null,
    };
  } catch {}
  const ledger = (await fs.readFile("/srv/kv/vault/_cache/automations/run-ledger.jsonl", "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.automation_id === "kv-daily-synthesis");
  const synthesisOutcome = ledger.filter((row) => row.event !== "run_started").at(-1);
  const synthesisRun = ledger.filter((row) => row.event === "run_started").at(-1);
  const mac = JSON.parse(macOut);
  mac.report_age_minutes = (Date.now() - Date.parse(mac.observed_at)) / 60000;
  const { stdout: tailscaleOut } = await execFile("tailscale", ["status", "--json"]);
  const tailscale = JSON.parse(tailscaleOut);
  const peerName = process.env.OUTCOME_MAC_TAILSCALE_NAME || "antonys-macbook-air";
  const macPeer = Object.values(tailscale.Peer || {}).find((peer) =>
    String(peer.DNSName || peer.HostName || "").toLowerCase().includes(peerName.toLowerCase()));
  const hostOnline = Boolean(macPeer?.Online);
  const previousAvailability = await readJsonOrNull(macAvailabilityFile);
  const availability = deriveMacAvailability({
    now,
    peerOnline: hostOnline,
    reportObservedAt: mac.observed_at,
    previous: previousAvailability,
  });
  const reconciliation = await readJsonOrNull(macReconciliationFile);
  if (availability.reconciliation?.state === "pending"
      && reconciliation?.id === availability.reconciliation.id
      && ["completed", "completed_with_warnings"].includes(reconciliation?.state)) {
    availability.reconciliation = reconciliation;
    const priorCompleted = ["completed", "completed_with_warnings"].includes(previousAvailability?.reconciliation?.state)
      && previousAvailability.reconciliation.id === reconciliation.id;
    if (!priorCompleted) {
      await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
      await fs.appendFile(macReconciliationLedger, `${JSON.stringify({
        event: "mac_return_reconciled",
        ts: reconciliation.completed_at,
        id: reconciliation.id,
        offline_window: reconciliation.offline_window,
        recovered: reconciliation.recovered,
      })}\n`, { mode: 0o600 });
    }
  }
  await writeJsonFileAtomic(macAvailabilityFile, availability);
  const reportFresh = mac.report_age_minutes <= 30;
  const localHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(new Date()));
  const daytimeExpected = localHour >= 7 && localHour < 23;
  const interactiveAvailable = reportFresh && Boolean(mac.interactive?.active);
  const healthyWhileInteractive = (healthy) => !interactiveAvailable || Boolean(healthy);
  mac.availability = {
    online: availability.mac_state !== "offline",
    state: availability.mac_state,
    last_seen: availability.mac_last_seen,
    source: "tailscale+reporter",
    peer: macPeer?.DNSName || macPeer?.HostName || null,
    reconciliation: availability.reconciliation,
  };
  mac.contracts = {
    reporter: { healthy: !hostOnline || !daytimeExpected || reportFresh },
    share_mount: { healthy: healthyWhileInteractive(mac.mount_present) },
    runtime_check: { healthy: healthyWhileInteractive(mac.launchagents?.runtime_check?.age_minutes <= 120 && mac.launchagents?.runtime_check?.exit_code === 0) },
    developer_mirrors: { healthy: healthyWhileInteractive(mac.launchagents?.developer_mirrors?.age_minutes <= 720 && mac.launchagents?.developer_mirrors?.exit_code === 0) },
    project_store: { healthy: healthyWhileInteractive(mac.launchagents?.project_store?.age_minutes <= 240 && mac.launchagents?.project_store?.exit_code === 0) },
  };
  return {
    doctor: {
      status: doctor.checks?.some((check) => check.status === "fail") ? "fail" : "pass",
      report_status: String(doctor.status).toLowerCase(),
    },
    borg: {
      healthy: Number.isFinite(borgAgeMinutes) && borgAgeMinutes <= 120 && (borgRunning || borgFreshnessSource === "latest_archive" || borgState.Result === "success"),
      newest_archive_age_minutes: borgAgeMinutes,
      service_state: borgState.ActiveState,
      freshness_source: borgFreshnessSource,
      full_legacy_coverage: borgScriptCoversLegacySources(borgScript),
    },
    mac,
    synthesis: {
      latest_clean: synthesisOutcomeIsClean(synthesisOutcome),
      latest_run_age_minutes: synthesisRun ? (Date.now() - Date.parse(synthesisRun.ts)) / 60000 : Number.POSITIVE_INFINITY,
    },
    sandbox: { ok: true },
    estate_steward: estateSteward,
  };
}

const matrix = await loadMatrix(matrixFile);
const snapshot = await collect();
const previous = await loadCards(cardsFile);
let shadowStartedAt = now;
try { shadowStartedAt = (await fs.readFile(`${stateDir}/shadow-started-at`, "utf8")).trim(); }
catch { await fs.mkdir(stateDir, { recursive: true, mode: 0o700 }); await fs.writeFile(`${stateDir}/shadow-started-at`, `${now}\n`, { mode: 0o600 }); }
const outcome = applyEvaluation({ matrix, snapshot, previous, now, shadowStartedAt });
await saveCards(cardsFile, outcome.cards);
await fs.writeFile(`${stateDir}/heartbeat`, `${now}\n`, { mode: 0o600 });
for (const transition of outcome.transitions) {
  const result = await dispatchOutcomeFailure({ transition, evidencePath: cardsFile });
  if (result && transition.card) {
    transition.card.steward_dispatched_at = now;
    transition.card.steward_thread_id = result.thread_id || result.threadId || null;
  }
}
for (const card of Object.values(outcome.cards)) {
  if (card.status !== "open" || card.severity !== "hard" || card.steward_dispatched_at) continue;
  const result = await dispatchOutcomeFailure({
    transition: { type: "migrated", notify: true, card },
    evidencePath: cardsFile,
  });
  if (result) {
    card.steward_dispatched_at = now;
    card.steward_thread_id = result.thread_id || result.threadId || null;
  }
}
await saveCards(cardsFile, outcome.cards);
console.log(JSON.stringify(outcome));
