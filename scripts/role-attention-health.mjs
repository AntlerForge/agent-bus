#!/usr/bin/env node
import path from "node:path";
import { readJsonFile } from "../src/io.mjs";
import { getBusRoot } from "../src/paths.mjs";
import { roleAttentionHealthFaults } from "../src/role-attention-health.mjs";

const root = getBusRoot();
const maxAgeMs = Number(process.env.ROLE_ATTENTION_HEALTH_MAX_AGE_SECONDS || 900) * 1000;
const snapshot = await readJsonFile(path.join(root, "_role-attention-monitor.json"), null);
const seats = await readJsonFile(path.join(root, "_role-seats.json"), null);
const faults = roleAttentionHealthFaults({ snapshot, seats, max_age_seconds: maxAgeMs / 1000 });
if (faults.length) { process.stderr.write(`${faults.join("; ")}\n`); process.exitCode = 1; }
else process.stdout.write(`${JSON.stringify({ status: "ok", monitor_last_success_at: snapshot.last_success_at, worker_last_seen_at: seats.worker.last_seen_at })}\n`);
