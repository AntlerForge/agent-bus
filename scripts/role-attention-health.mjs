#!/usr/bin/env node
import path from "node:path";
import { readJsonFile } from "../src/io.mjs";
import { getBusRoot } from "../src/paths.mjs";

const root = getBusRoot();
const maxAgeMs = Number(process.env.ROLE_ATTENTION_HEALTH_MAX_AGE_SECONDS || 900) * 1000;
const snapshot = await readJsonFile(path.join(root, "_role-attention-monitor.json"), null);
const seats = await readJsonFile(path.join(root, "_role-seats.json"), null);
const faults = [];
if (!snapshot?.last_success_at || Date.now() - new Date(snapshot.last_success_at).getTime() > maxAgeMs) faults.push("attention monitor snapshot is stale");
if (!seats?.worker?.last_seen_at || Date.now() - new Date(seats.worker.last_seen_at).getTime() > maxAgeMs) faults.push("Mac role-wake worker heartbeat is stale");
if (faults.length) { process.stderr.write(`${faults.join("; ")}\n`); process.exitCode = 1; }
else process.stdout.write(`${JSON.stringify({ status: "ok", monitor_last_success_at: snapshot.last_success_at, worker_last_seen_at: seats.worker.last_seen_at })}\n`);
