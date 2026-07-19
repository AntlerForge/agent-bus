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
for (const [label, candidates] of Object.entries(specs)) {
  const files = candidates.map((p) => path.join(home, p)).filter(fs.existsSync);
  const mtime = files.length ? Math.max(...files.map((f) => fs.statSync(f).mtimeMs)) : 0;
  launchagents[label] = { age_minutes: mtime ? (Date.now() - mtime) / 60000 : null };
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
