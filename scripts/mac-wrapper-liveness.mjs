#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_WRAPPERS = [
  {
    id: "pbv-a6-sync",
    processNeedle: "/Applications/AntlerForge/PBV A6 Sync Bridge.app/Contents/MacOS/applet",
    outputPath: "Library/Logs/pbv-a6-sync.log",
    maxOutputAgeMinutes: 26 * 60,
    launchdLabel: "com.antlerforge.pbv-a6-sync",
  },
  {
    id: "kv-project-store-sync",
    processNeedle: "/Applications/AntlerForge/KV Project Store Sync Bridge.app/Contents/MacOS/applet",
    outputPath: "Documents/Admin/knowledge-vault/logs/project-store-sync-bridge.log",
    maxOutputAgeMinutes: 150,
    launchdLabel: "com.antlerforge.kv-project-store-sync",
  },
];

export function evaluateWrapper({ running, outputMtimeMs, nowMs, maxOutputAgeMinutes }) {
  const outputAgeMinutes = outputMtimeMs == null ? null : (nowMs - outputMtimeMs) / 60000;
  return {
    running,
    outputAgeMinutes,
    stale: Boolean(running && (outputAgeMinutes == null || outputAgeMinutes > maxOutputAgeMinutes)),
  };
}

function processes() {
  const text = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return text.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
}

function restart(wrapper, pids, uid) {
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  execFileSync("/bin/sleep", ["2"]);
  for (const pid of pids) {
    try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  execFileSync("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${wrapper.launchdLabel}`]);
}

export function inspectWrappers({ wrappers = DEFAULT_WRAPPERS, home = os.homedir(), nowMs = Date.now(), dryRun = false, processList, restartFn = restart } = {}) {
  const ps = processList ?? processes();
  const uid = process.getuid();
  return wrappers.map((wrapper) => {
    const pids = ps.filter((entry) => entry.command.includes(wrapper.processNeedle)).map((entry) => entry.pid);
    const outputPath = path.join(home, wrapper.outputPath);
    let outputMtimeMs = null;
    try { outputMtimeMs = fs.statSync(outputPath).mtimeMs; } catch (error) { if (error.code !== "ENOENT") throw error; }
    const state = evaluateWrapper({ running: pids.length > 0, outputMtimeMs, nowMs, maxOutputAgeMinutes: wrapper.maxOutputAgeMinutes });
    let action = "none";
    if (state.stale) {
      action = dryRun ? "would_restart" : "restarted";
      if (!dryRun) restartFn(wrapper, pids, uid);
    }
    return { id: wrapper.id, ...state, maxOutputAgeMinutes: wrapper.maxOutputAgeMinutes, pids, action };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = inspectWrappers({ dryRun: process.env.MAC_WRAPPER_LIVENESS_DRY_RUN === "1" });
  process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), wrappers: result })}\n`);
}
