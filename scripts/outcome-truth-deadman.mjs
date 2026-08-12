#!/usr/bin/env node
import fs from "node:fs/promises";
import { dispatchSentinelDeadman } from "../src/estate-steward/dispatch.mjs";
const dir = process.env.OUTCOME_STATE_DIR || "/srv/projects/Personal/agent-bus/runtime/outcome-truth";
const maxMs = Number(process.env.OUTCOME_DEADMAN_MINUTES || 35) * 60000;
let heartbeat = 0;
try { heartbeat = Date.parse((await fs.readFile(`${dir}/heartbeat`, "utf8")).trim()); } catch {}
if (!heartbeat || Date.now() - heartbeat > maxMs) {
  const bucket = new Date().toISOString().slice(0, 13);
  try {
    await dispatchSentinelDeadman({ bucket, maxMinutes: maxMs / 60000 });
  } catch (error) {
    console.error(`Could not dispatch the deadman incident to the Estate Steward: ${error.message}`);
    process.exitCode = 1;
  }
}
