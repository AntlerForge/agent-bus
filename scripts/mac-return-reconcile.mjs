#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const availabilityFile = process.argv[2];
const outputFile = process.argv[3];
const availability = JSON.parse(fs.readFileSync(availabilityFile, "utf8"));
const pending = availability.reconciliation;
if (!pending || pending.state !== "pending") process.exit(0);

const recovered = [];
const failures = [];
const dryRun = process.env.MAC_RECONCILE_DRY_RUN === "1";
const run = (label, file, args = []) => {
  if (dryRun) { recovered.push(label); return; }
  try {
    execFileSync(file, args, { stdio: "ignore", timeout: 120000 });
    recovered.push(label);
  } catch (error) { failures.push(`${label}: exit ${error.status ?? "unknown"}`); }
};
const uid = process.getuid();
for (const label of [
  "com.antlerforge.agent-bus-a6-tunnel",
  "com.antlerforge.a6-share-mount",
  "com.antlerforge.kv-mac-runtime-check",
  "com.antlerforge.kv-developer-mirrors-sync",
  "com.antlerforge.kv-project-store-sync",
]) run(label, "/bin/launchctl", ["kickstart", `gui/${uid}/${label}`]);

const bridge = path.join(os.homedir(), "Developer/personal/knowledge-vault/scripts/kv_mac_runtime_check.sh");
if (fs.existsSync(bridge)) run("apple-source-bridge", bridge, ["--run-apple-bridge"]);

fs.writeFileSync(outputFile, `${JSON.stringify({
  id: pending.id,
  state: failures.length ? "completed_with_warnings" : "completed",
  completed_at: new Date().toISOString(),
  offline_window: pending.offline_window,
  recovered,
  failures,
})}\n`, { mode: 0o600 });
