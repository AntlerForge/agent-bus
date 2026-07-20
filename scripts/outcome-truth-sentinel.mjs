#!/usr/bin/env node
import fs from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { applyEvaluation, loadCards, loadMatrix, saveCards } from "../src/outcome-truth/core.mjs";

const execFile = promisify(execFileCb);
const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => v.startsWith("--") ? [v.slice(2), a[i + 1]] : null).filter(Boolean));
const matrixFile = args.matrix || process.env.OUTCOME_MATRIX || "config/outcome-truth-matrix.v1.yaml";
const stateDir = process.env.OUTCOME_STATE_DIR || "/srv/projects/Personal/agent-bus/runtime/outcome-truth";
const cardsFile = `${stateDir}/cards.json`;
const snapshotFile = args.snapshot || process.env.OUTCOME_SNAPSHOT;
const now = process.env.OUTCOME_NOW || new Date().toISOString();

async function collect() {
  if (snapshotFile) return JSON.parse(await fs.readFile(snapshotFile, "utf8"));
  const doctor = JSON.parse(await fs.readFile("/srv/kv/vault/dashboard/doctor.json", "utf8"));
  const borgScript = await fs.readFile("/usr/local/sbin/antler-a6-borg-backup.sh", "utf8");
  const { stdout: borgOut } = await execFile("systemctl", ["show", "antler-a6-borg-backup.service", "-p", "ExecMainExitTimestamp", "--value"]);
  const borgTime = Date.parse(borgOut.trim());
  const macFile = process.env.OUTCOME_MAC_SNAPSHOT || `${stateDir}/mac-snapshot.json`;
  const macOut = await fs.readFile(macFile, "utf8");
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
  const healthyWhileAvailable = (healthy) => !hostOnline || Boolean(healthy);
  mac.availability = {
    online: hostOnline,
    source: "tailscale",
    peer: macPeer?.DNSName || macPeer?.HostName || null,
  };
  mac.contracts = {
    reporter: { healthy: healthyWhileAvailable(mac.report_age_minutes <= 30) },
    share_mount: { healthy: healthyWhileAvailable(mac.mount_present) },
    runtime_check: { healthy: healthyWhileAvailable(mac.launchagents?.runtime_check?.age_minutes <= 120) },
    developer_mirrors: { healthy: healthyWhileAvailable(mac.launchagents?.developer_mirrors?.age_minutes <= 720) },
    project_store: { healthy: healthyWhileAvailable(mac.launchagents?.project_store?.age_minutes <= 240) },
  };
  return {
    doctor: {
      status: doctor.checks?.some((check) => check.status === "fail") ? "fail" : "pass",
      report_status: String(doctor.status).toLowerCase(),
    },
    borg: {
      newest_archive_age_minutes: (Date.now() - borgTime) / 60000,
      full_legacy_coverage: /(^|\s)\/share(\s|$)/m.test(borgScript) && /(^|\s)\/srv(\s|$)/m.test(borgScript),
    },
    mac,
    synthesis: {
      latest_clean: synthesisOutcome?.event === "run_completed",
      latest_run_age_minutes: synthesisRun ? (Date.now() - Date.parse(synthesisRun.ts)) / 60000 : Number.POSITIVE_INFINITY,
    },
    sandbox: { ok: true },
  };
}

async function notify(transition) {
  if (!transition.notify || process.env.OUTCOME_NO_NOTIFY === "1") return;
  const recovered = transition.type === "recovered";
  const body = `${recovered ? "RECOVERED" : "FAILED"}: ${transition.card.check_id}${recovered ? " passed its semantic recovery contract" : " requires attention"}`;
  await execFile(process.execPath, ["scripts/ha-notify-tony.mjs", "--class", "ALERT", "--id", `outcome-${transition.card.card_id}-${transition.type}-${transition.card.last_seen}`, "--message", body]);
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
for (const transition of outcome.transitions) await notify(transition);
if (process.env.OUTCOME_DAILY_INFO === "1" && outcome.results.every((r) => r.state === "pass")) {
  const message = process.env.OUTCOME_INFO_MESSAGE || "All enabled semantic contracts are healthy.";
  await execFile(process.execPath, ["scripts/ha-notify-tony.mjs", "--class", "INFO", "--id", `outcome-all-clear-${now.slice(0,10)}`, "--message", message]);
}
console.log(JSON.stringify(outcome));
