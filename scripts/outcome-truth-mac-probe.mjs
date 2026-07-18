#!/usr/bin/env node
import fs from "node:fs";
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
console.log(JSON.stringify({ observed_at: new Date().toISOString(), mount_present: fs.existsSync("/Volumes/share"), launchagents }));
