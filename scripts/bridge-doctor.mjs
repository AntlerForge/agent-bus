#!/usr/bin/env node
// Transport-health doctor for the Agent Bus bridges, tunnel and control plane.
// When a bridge is unhealthy the answer is: repair with the printed command or
// report "manual handoff required, bridge down". Computer-use GUI driving of
// provider apps is never a fallback.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { runRoundTrip } from "./bridge-roundtrip.mjs";

const execFileAsync = promisify(execFile);

const TUNNEL_LABEL = "com.antlerforge.agent-bus-a6-tunnel";
const BRIDGE_LABELS = {
  codex: "com.antlerforge.agent-bus-codex-bridge",
  cursor: "com.antlerforge.agent-bus-cursor-bridge",
  antigravity: "com.antlerforge.agent-bus-antigravity-bridge",
};
const TUNNEL_ERR_LOG = path.join(os.homedir(), "var/log/home-platform/agent-bus/a6-tunnel.err.log");

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.AGENT_BUS_CONTROL_PLANE_URL || "http://127.0.0.1:18091/agent-bus",
    targets: [],
    roundtrip: false,
    repair: true,
    notify: false,
    json: false,
    timeoutMs: 5 * 60 * 1000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") options.targets.push(argv[++index]);
    else if (arg === "--url") options.baseUrl = argv[++index];
    else if (arg === "--roundtrip") options.roundtrip = true;
    else if (arg === "--no-repair") options.repair = false;
    else if (arg === "--notify") options.notify = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--timeout-ms") options.timeoutMs = Number.parseInt(argv[++index], 10);
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npm run bridge:doctor [-- options]

Checks, per target: LaunchAgent loaded and process alive, tunnel health,
control-plane reachability and heartbeat freshness. Prints a table plus the
exact repair command for every failure.

Options:
  --target <id>     Restrict bridge checks (codex, cursor, antigravity). Default: all.
  --url <url>       Control-plane base URL. Default: ${options.baseUrl}
  --roundtrip       Also run a live message round trip through healthy bridges.
  --no-repair       Diagnose only; never kickstart the tunnel automatically.
  --notify          Send a Home Assistant ALERT (via A6) for each down bridge.
  --json            Emit machine-readable JSON instead of the table.
  --timeout-ms <n>  Round-trip timeout. Default: 300000.`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.targets.length) options.targets = Object.keys(BRIDGE_LABELS);
  for (const target of options.targets) {
    if (!BRIDGE_LABELS[target]) throw new Error(`Unknown target: ${target}`);
  }
  return options;
}

async function launchAgentState(label) {
  try {
    const { stdout } = await execFileAsync("launchctl", ["print", `gui/${process.getuid()}/${label}`], { maxBuffer: 1024 * 1024 });
    const pid = stdout.match(/^\s*pid = (\d+)$/m)?.[1] || null;
    const state = stdout.match(/^\s*state = (\S+)$/m)?.[1] || "unknown";
    const lastExit = stdout.match(/^\s*last exit code = (\S+)$/m)?.[1] || null;
    const runs = stdout.match(/^\s*runs = (\d+)$/m)?.[1] || null;
    return { loaded: true, running: state === "running" && pid !== null, pid, state, last_exit: lastExit, runs: runs ? Number(runs) : null };
  } catch {
    return { loaded: false, running: false, pid: null, state: "not loaded", last_exit: null, runs: null };
  }
}

async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { ok: response.ok, status: response.status, body: await response.json() };
  } finally {
    clearTimeout(timer);
  }
}

async function tailFile(filePath, bytes = 4096) {
  try {
    const content = await readFile(filePath, "utf8");
    return content.slice(-bytes);
  } catch {
    return "";
  }
}

function repairCommand(label, { loaded }) {
  if (!loaded) {
    return `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/${label}.plist`;
  }
  return `launchctl kickstart -k gui/$UID/${label}`;
}

async function kickstart(label) {
  await execFileAsync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${label}`]);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notifyDown(target) {
  const id = `bridge-doctor:${target}:down`;
  const message = `Agent Bus ${target} is down; run npm run bridge:doctor on the Mac`;
  await execFileAsync("ssh", [
    "-o", "BatchMode=yes", "ajbarfoot@antler-a6",
    `cd /srv/projects/Personal/agent-bus/app && node scripts/ha-notify-tony.mjs --class ALERT --id '${id}' --message '${message}'`,
  ]);
}

export async function runDoctor(options, { log = console.log } = {}) {
  const checks = [];
  const record = (target, check, healthy, detail, repair = null) => {
    checks.push({ target, check, healthy, detail, repair });
  };

  // 1. Tunnel LaunchAgent + diagnosis.
  let tunnel = await launchAgentState(TUNNEL_LABEL);
  const tunnelLog = await tailFile(TUNNEL_ERR_LOG);
  const fdExhausted = /Too many open files/.test(tunnelLog);
  let controlPlane = null;
  try {
    controlPlane = await fetchJson(`${options.baseUrl}/healthz`);
  } catch {
    controlPlane = { ok: false, status: null };
  }
  const tunnelBroken = !tunnel.running || !controlPlane.ok;
  if (tunnelBroken && options.repair) {
    log(`Tunnel unhealthy (running=${tunnel.running}, control plane ok=${controlPlane.ok}, fd exhaustion in log=${fdExhausted}); kickstarting ${TUNNEL_LABEL}…`);
    try {
      await kickstart(TUNNEL_LABEL);
      await wait(3000);
      tunnel = await launchAgentState(TUNNEL_LABEL);
      try {
        controlPlane = await fetchJson(`${options.baseUrl}/healthz`);
      } catch {
        controlPlane = { ok: false, status: null };
      }
    } catch (error) {
      log(`Kickstart failed: ${error.message}`);
    }
  }
  record("tunnel", "LaunchAgent running", tunnel.running,
    `state=${tunnel.state} pid=${tunnel.pid || "-"} last_exit=${tunnel.last_exit ?? "-"} runs=${tunnel.runs ?? "-"}`,
    tunnel.running ? null : repairCommand(TUNNEL_LABEL, tunnel));
  if (fdExhausted) {
    const currentFailure = tunnelBroken;
    record("tunnel", "File descriptors", !currentFailure,
      currentFailure
        ? "err.log shows 'accept: Too many open files' and the tunnel is unreachable — ssh hit its fd limit; ensure the plist sets SoftResourceLimits NumberOfFiles, then kickstart"
        : "err.log contains historical 'accept: Too many open files' entries; tunnel currently healthy (fd limits raised 2026-08-11). Rotate the log to clear this notice.",
      currentFailure ? `launchctl kickstart -k gui/$UID/${TUNNEL_LABEL}` : null);
  }

  // 2. Control-plane reachability through the tunnel.
  record("control-plane", "healthz reachable", Boolean(controlPlane.ok),
    controlPlane.ok ? `${options.baseUrl}/healthz ok` : `no response from ${options.baseUrl}/healthz`,
    controlPlane.ok ? null : `launchctl kickstart -k gui/$UID/${TUNNEL_LABEL} # then re-run; if it persists check the A6 container: ssh ajbarfoot@antler-a6 'docker ps --filter name=agent-bus-control-plane'`);

  // 3. Per-bridge LaunchAgent + heartbeat freshness.
  let status = null;
  if (controlPlane.ok) {
    try {
      const statusResponse = await fetchJson(`${options.baseUrl}/api/v1/agents/status`);
      status = statusResponse.ok ? statusResponse.body : null;
    } catch {
      status = null;
    }
  }
  record("control-plane", "status API", Boolean(status),
    status ? `agents status generated ${status.generated_at}` : "GET /api/v1/agents/status failed",
    status ? null : "Deploy the liveness-enabled control plane to A6 and rebuild the container");

  for (const target of options.targets) {
    const label = BRIDGE_LABELS[target];
    const agentState = await launchAgentState(label);
    record(target, "LaunchAgent running", agentState.running,
      `state=${agentState.state} pid=${agentState.pid || "-"} last_exit=${agentState.last_exit ?? "-"}`,
      agentState.running ? null : repairCommand(label, agentState));
    const heartbeat = status?.agents?.find((agent) => agent.agent_id === target);
    const liveness = heartbeat?.liveness || "unknown";
    const healthy = liveness === "fresh";
    record(target, "Heartbeat", healthy,
      heartbeat ? `${liveness}; state=${heartbeat.state}; last ${heartbeat.seconds_since_heartbeat ?? "?"}s ago` : "no heartbeat recorded",
      healthy ? null : repairCommand(label, agentState));
    if (options.notify && liveness === "down") {
      try {
        await notifyDown(target);
        log(`Sent HA ALERT for ${target}.`);
      } catch (error) {
        log(`HA notify failed for ${target}: ${error.message}`);
      }
    }
  }

  // 4. Optional live round trip through healthy bridges only.
  let roundtrip = null;
  if (options.roundtrip) {
    const healthyTargets = options.targets.filter((target) =>
      checks.some((check) => check.target === target && check.check === "Heartbeat" && check.healthy));
    if (healthyTargets.length) {
      try {
        roundtrip = await runRoundTrip({ ...options, targets: healthyTargets, artifact: false });
        for (const result of roundtrip.results) {
          record(result.target, "Round trip", true, `replied on ${result.thread_id}`);
        }
      } catch (error) {
        record("roundtrip", "Round trip", false, error.message, "Investigate the bridge log under ~/var/log/home-platform/agent-bus/");
      }
    } else {
      record("roundtrip", "Round trip", false, "skipped: no bridge with a fresh heartbeat");
    }
  }

  const failures = checks.filter((check) => !check.healthy);
  return { healthy: failures.length === 0, checks, failures, roundtrip };
}

function printTable(report) {
  const rows = report.checks.map((check) => [check.healthy ? "OK" : "FAIL", check.target, check.check, check.detail]);
  const widths = [4, 13, 22];
  console.log(["RES ", "TARGET       ", "CHECK                 ", "DETAIL"].join(" "));
  for (const row of rows) {
    console.log([row[0].padEnd(widths[0]), row[1].padEnd(widths[1]), row[2].padEnd(widths[2]), row[3]].join(" "));
  }
  if (report.failures.length) {
    console.log("\nRepairs:");
    for (const failure of report.failures) {
      if (failure.repair) console.log(`  [${failure.target}] ${failure.repair}`);
    }
    console.log("\nIf a bridge cannot be repaired, report: manual handoff required, bridge down.");
    console.log("Never fall back to computer-use GUI driving of provider apps.");
  } else {
    console.log("\nAll transport checks healthy.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  const report = await runDoctor(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTable(report);
  }
  process.exit(report.healthy ? 0 : 1);
}
