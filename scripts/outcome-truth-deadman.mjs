#!/usr/bin/env node
import fs from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
const execFile = promisify(execFileCb);
const dir = process.env.OUTCOME_STATE_DIR || "/srv/projects/Personal/agent-bus/runtime/outcome-truth";
const maxMs = Number(process.env.OUTCOME_DEADMAN_MINUTES || 35) * 60000;
let heartbeat = 0;
try { heartbeat = Date.parse((await fs.readFile(`${dir}/heartbeat`, "utf8")).trim()); } catch {}
if (!heartbeat || Date.now() - heartbeat > maxMs) {
  const bucket = new Date().toISOString().slice(0, 13);
  await execFile(process.execPath, ["scripts/ha-notify-tony.mjs", "--class", "ALERT", "--id", `outcome-sentinel-dead-${bucket}`, "--title", "ALERT: outcome sentinel silent", "--message", `No sentinel heartbeat within ${maxMs / 60000} minutes.`]);
  process.exitCode = 1;
}

