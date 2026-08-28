#!/usr/bin/env node
import path from "node:path";
import { createRemoteRoleSeats } from "../src/role-seats-remote.mjs";
import { evaluateRoleAttention, DEFAULT_ROLE_ATTENTION_THRESHOLDS } from "../src/role-attention.mjs";
import { executeRoleAttentionCycle } from "../src/role-attention-monitor.mjs";
import { getBusRoot } from "../src/paths.mjs";
import { getWriteToken } from "../src/write-token.mjs";
import { getRoleWakeCredential, ROLE_WAKE_MONITOR } from "../src/role-wake-auth.mjs";

const credential = getRoleWakeCredential();
if (credential?.identity !== ROLE_WAKE_MONITOR) throw new Error("Estate operations monitor credential is required");
const number = (name, fallback) => Number(process.env[name] || fallback);
const thresholds = {
  unread_response_seconds: number("ROLE_ATTENTION_UNREAD_SECONDS", DEFAULT_ROLE_ATTENTION_THRESHOLDS.unread_response_seconds),
  waiting_run_seconds: number("ROLE_ATTENTION_WAITING_RUN_SECONDS", DEFAULT_ROLE_ATTENTION_THRESHOLDS.waiting_run_seconds),
  pending_review_seconds: number("ROLE_ATTENTION_REVIEW_SECONDS", DEFAULT_ROLE_ATTENTION_THRESHOLDS.pending_review_seconds),
  patrol_seconds: number("ROLE_ATTENTION_PATROL_SECONDS", DEFAULT_ROLE_ATTENTION_THRESHOLDS.patrol_seconds),
};
const root = getBusRoot();
const client = createRemoteRoleSeats(process.env.AGENT_BUS_CONTROL_PLANE_URL || "http://127.0.0.1:18091/agent-bus", { writeToken: getWriteToken(), roleWakeCredential: credential });
const evaluation = await evaluateRoleAttention({ thresholds }, root);
const result = await executeRoleAttentionCycle({ evaluation, thresholds, client, snapshot_file: path.join(root, "_role-attention-monitor.json") });
process.stdout.write(`${JSON.stringify(result)}\n`);
