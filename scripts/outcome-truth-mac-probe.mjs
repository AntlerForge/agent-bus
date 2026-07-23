#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = process.env.HOME;
const specs = {
  share_mount: ["Library/Logs/AntlerForge/a6-share-mount.out.log", "Library/Logs/AntlerForge/a6-share-mount.err.log"],
  runtime_check: ["Library/Logs/AntlerForge/kv-mac-runtime-check.out.log", "Library/Logs/AntlerForge/kv-mac-runtime-check.err.log"],
  developer_mirrors: ["Library/Logs/AntlerForge/kv-developer-mirrors-sync.out.log", "Library/Logs/AntlerForge/kv-developer-mirrors-sync.err.log"],
  project_store: ["Library/Logs/AntlerForge/kv-project-store-sync.out.log", "Library/Logs/AntlerForge/kv-project-store-sync.err.log"],
};
const launchagents = {};
const markerNames = {
  share_mount: "a6-share-mount.json",
  runtime_check: "kv-mac-runtime-check.json",
  developer_mirrors: "kv-developer-mirrors-sync.json",
};
for (const [label, candidates] of Object.entries(specs)) {
  let completedAt = null;
  let exitCode = null;
  const marker = markerNames[label] && path.join(home, "Library/Application Support/AntlerForge/outcome-truth", markerNames[label]);
  if (marker && fs.existsSync(marker)) {
    const parsed = JSON.parse(fs.readFileSync(marker, "utf8"));
    completedAt = parsed.completed_at;
    exitCode = parsed.exit_code;
  } else if (label === "project_store") {
    const bridgeLog = path.join(home, "Documents/Admin/knowledge-vault/logs/project-store-sync-bridge.log");
    if (fs.existsSync(bridgeLog)) {
      const matches = [...fs.readFileSync(bridgeLog, "utf8").matchAll(/^(\S+) bridge end rc=(\d+)$/gm)];
      if (matches.length) [completedAt, exitCode] = [matches.at(-1)[1], Number(matches.at(-1)[2])];
    }
  }
  const files = candidates.map((p) => path.join(home, p)).filter(fs.existsSync);
  const fallbackMtime = files.length ? Math.max(...files.map((f) => fs.statSync(f).mtimeMs)) : 0;
  const observedMs = completedAt ? Date.parse(completedAt) : fallbackMtime;
  launchagents[label] = { age_minutes: observedMs ? (Date.now() - observedMs) / 60000 : null, exit_code: exitCode, completed_at: completedAt };
}
let repo_sweep = { observed_at: null, age_minutes: null, findings: [], counts: {}, propose_only: null };
const repoSweepFile = process.env.REPO_RISK_OUTPUT || path.join(home, "Library/Application Support/Agent Bus/repo-risk/latest.json");
if (fs.existsSync(repoSweepFile)) {
  repo_sweep = JSON.parse(fs.readFileSync(repoSweepFile, "utf8"));
  repo_sweep.age_minutes = (Date.now() - Date.parse(repo_sweep.observed_at)) / 60000;
}
const localBusRoot = path.join(os.homedir(), "AgentBus");
const quarantine = "_misrouted-quarantine-20260719";
const unexpectedLocalWrites = [];
if (fs.existsSync(localBusRoot)) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dir === localBusRoot && entry.name === quarantine) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else unexpectedLocalWrites.push(path.relative(localBusRoot, full));
    }
  };
  walk(localBusRoot);
}
console.log(JSON.stringify({ observed_at: new Date().toISOString(), mount_present: fs.existsSync("/Volumes/share"), launchagents,
  repo_sweep, local_bus: { unexpected_write_count: unexpectedLocalWrites.length, unexpected_paths: unexpectedLocalWrites.slice(0, 20) } }));
