#!/usr/bin/env node
import fs from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { applyEvaluation, evaluateMatrix, loadCards, loadMatrix, saveCards, synthesisSemanticallyClean } from "../src/outcome-truth/core.mjs";
import { renderEstateStatus } from "../src/estate-status/render.mjs";

const execFile = promisify(execFileCb);
const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => v.startsWith("--") ? [v.slice(2), a[i + 1]] : null).filter(Boolean));
const matrixFile = args.matrix || process.env.OUTCOME_MATRIX || "config/outcome-truth-matrix.v1.yaml";
const stateDir = process.env.OUTCOME_STATE_DIR || "/srv/projects/Personal/agent-bus/runtime/outcome-truth";
const cardsFile = `${stateDir}/cards.json`;
const snapshotFile = args.snapshot || process.env.OUTCOME_SNAPSHOT;
const now = process.env.OUTCOME_NOW || new Date().toISOString();
const runtimeRoot = process.env.AGENT_BUS_RUNTIME || "/srv/projects/Personal/agent-bus/runtime";
const statusUrl = process.env.ESTATE_STATUS_URL || "https://kv.antlerforge.com/#tasks";

async function collect() {
  if (snapshotFile) return JSON.parse(await fs.readFile(snapshotFile, "utf8"));
  const doctor = JSON.parse(await fs.readFile("/srv/kv/vault/dashboard/doctor.json", "utf8"));
  const borgScript = await fs.readFile("/usr/local/sbin/antler-a6-borg-backup.sh", "utf8");
  const { stdout: borgOut } = await execFile("systemctl", ["show", "antler-a6-borg-backup.service", "-p", "ActiveState", "-p", "ExecMainStartTimestamp", "-p", "ExecMainExitTimestamp", "-p", "Result"]);
  const borgState = Object.fromEntries(borgOut.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
  const borgRunning = ["active", "activating"].includes(borgState.ActiveState);
  const borgTime = Date.parse(borgRunning ? borgState.ExecMainStartTimestamp : borgState.ExecMainExitTimestamp);
  const borgAgeMinutes = (Date.now() - borgTime) / 60000;
  const macFile = process.env.OUTCOME_MAC_SNAPSHOT || `${stateDir}/mac-snapshot.json`;
  const macOut = await fs.readFile(macFile, "utf8");
  const ledger = (await fs.readFile("/srv/kv/vault/_cache/automations/run-ledger.jsonl", "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.automation_id === "kv-daily-synthesis");
  const synthesisOutcome = ledger.filter((row) => row.event !== "run_started").at(-1);
  const synthesisRun = ledger.filter((row) => row.event === "run_started").at(-1);
  let gristStatus = null;
  try {
    gristStatus = JSON.parse(await fs.readFile(`${runtimeRoot}/grist-workbench-sync/status.json`, "utf8"));
  } catch {}
  const gristAgeMinutes = gristStatus?.synced_at ? (Date.now() - Date.parse(gristStatus.synced_at)) / 60000 : null;
  const mac = JSON.parse(macOut);
  mac.report_age_minutes = (Date.now() - Date.parse(mac.observed_at)) / 60000;
  const { stdout: tailscaleOut } = await execFile("tailscale", ["status", "--json"]);
  const tailscale = JSON.parse(tailscaleOut);
  const peerName = process.env.OUTCOME_MAC_TAILSCALE_NAME || "antonys-macbook-air";
  const macPeer = Object.values(tailscale.Peer || {}).find((peer) =>
    String(peer.DNSName || peer.HostName || "").toLowerCase().includes(peerName.toLowerCase()));
  const hostOnline = Boolean(macPeer?.Online);
  const reportFresh = mac.report_age_minutes <= 30;
  const localHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(new Date()));
  const daytimeExpected = localHour >= 7 && localHour < 23;
  const interactiveAvailable = reportFresh && Boolean(mac.interactive?.active);
  const healthyWhileInteractive = (healthy) => !interactiveAvailable || Boolean(healthy);
  mac.availability = {
    online: hostOnline,
    source: "tailscale",
    peer: macPeer?.DNSName || macPeer?.HostName || null,
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
      healthy: Number.isFinite(borgAgeMinutes) && borgAgeMinutes <= 120 && (borgRunning || borgState.Result === "success"),
      newest_archive_age_minutes: borgAgeMinutes,
      service_state: borgState.ActiveState,
      full_legacy_coverage: /(^|\s)\/share(\s|$)/m.test(borgScript) && /(^|\s)\/srv(\s|$)/m.test(borgScript),
    },
    mac,
    synthesis: {
      latest_clean: synthesisSemanticallyClean(synthesisOutcome),
      latest_event: synthesisOutcome?.event || null,
      latest_run_age_minutes: synthesisRun ? (Date.now() - Date.parse(synthesisRun.ts)) / 60000 : Number.POSITIVE_INFINITY,
    },
    grist: {
      healthy: gristStatus && Number.isFinite(gristAgeMinutes)
        ? gristStatus.status === "ok" && gristAgeMinutes <= 30 && gristStatus.protected_before_hash === gristStatus.protected_after_hash
        : null,
      age_minutes: gristAgeMinutes,
      conflicts: gristStatus?.conflicts ?? null,
    },
    sandbox: { ok: true },
  };
}

async function notify(transition) {
  if (!transition.notify || process.env.OUTCOME_NO_NOTIFY === "1") return;
  const recovered = transition.type === "recovered" || transition.type === "probe_fault_recovered";
  const probeFault = transition.card.card_class === "probe_fault";
  const body = probeFault
    ? `${recovered ? "PROBE RECOVERED" : "PROBE FAULT"}: sentinel ${recovered ? "can see" : "cannot see"} ${transition.card.probe_check_id}`
    : `${recovered ? "RECOVERED" : "FAILED"}: ${transition.card.check_id}${recovered ? " passed its semantic recovery contract" : " requires attention"}`;
  await execFile(process.execPath, ["scripts/ha-notify-tony.mjs", "--class", "ALERT", "--id", `outcome-${transition.card.card_id}-${transition.type}-${transition.card.last_seen}`, "--message", body, "--url", statusUrl]);
}

const matrix = await loadMatrix(matrixFile);
const snapshot = await collect();
if (args["self-test"] != null) {
  const results = evaluateMatrix(matrix, snapshot);
  const faults = results.filter((result) => result.state === "probe_fault");
  console.log(JSON.stringify({ ok: faults.length === 0, checked: results.length, faults, snapshot }, null, 2));
  process.exitCode = faults.length ? 1 : 0;
} else {
const previous = await loadCards(cardsFile);
let shadowStartedAt = now;
try { shadowStartedAt = (await fs.readFile(`${stateDir}/shadow-started-at`, "utf8")).trim(); }
catch { await fs.mkdir(stateDir, { recursive: true, mode: 0o700 }); await fs.writeFile(`${stateDir}/shadow-started-at`, `${now}\n`, { mode: 0o600 }); }
const outcome = applyEvaluation({ matrix, snapshot, previous, now, shadowStartedAt });
await saveCards(cardsFile, outcome.cards);
await fs.writeFile(`${stateDir}/heartbeat`, `${now}\n`, { mode: 0o600 });
await renderEstateStatus({ runtimeRoot, generatedAt: now, statusUrl });
for (const transition of outcome.transitions) await notify(transition);
if (process.env.OUTCOME_DAILY_INFO === "1" && outcome.results.every((r) => r.state === "pass")) {
  const message = process.env.OUTCOME_INFO_MESSAGE || "All enabled semantic contracts are healthy.";
  await execFile(process.execPath, ["scripts/ha-notify-tony.mjs", "--class", "INFO", "--id", `outcome-all-clear-${now.slice(0,10)}`, "--message", message]);
}
await renderEstateStatus({ runtimeRoot, generatedAt: now, statusUrl });
console.log(JSON.stringify(outcome));
}
