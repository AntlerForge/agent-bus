#!/usr/bin/env node
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createRemoteRoleSeats } from "../src/role-seats-remote.mjs";
import { getWriteToken } from "../src/write-token.mjs";

const url = process.env.AGENT_BUS_CONTROL_PLANE_URL || "http://127.0.0.1:18091/agent-bus";
const client = createRemoteRoleSeats(url, { writeToken: getWriteToken() });
const worker = `${os.hostname()}:${process.pid}`;
const desks = {
  "coherence-manager": path.join(os.homedir(), "Documents/Admin/roles/coherence-manager"),
  "estate-operations-manager": path.join(os.homedir(), "Documents/Admin/roles/estate-operations-manager"),
  "estate-architect": path.join(os.homedir(), "Documents/Admin/roles/estate-architect"),
};

function run(role, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ROLE_WAKE_CODEX_COMMAND || "codex", ["-a", "never", "exec", "--sandbox", "workspace-write", "-C", desks[role], "-"], { stdio: ["pipe", "inherit", "inherit"], env: process.env });
    child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`role session exited ${code}`)));
    child.stdin.end(prompt);
  });
}

const claimed = await client.claim({ worker_id: worker, host: os.hostname() });
if (!claimed) process.exit(0);
const { request, seat } = claimed;
const prompt = `You are seated only as ${request.role}. Load that role's canonical skill and run its wake ritual. Consult the explicit Agent Bus seat record ${seat.seat_id}; do not use identity last_seen as occupancy evidence. Work the role queue for: ${request.reason}. Source: ${request.source_ref || "on-demand wake"}. Stay within the role charter; waking grants no new authority. Update the role ledger, then end this bounded seating.`;
try {
  await run(request.role, prompt);
  await client.unseat({ role: request.role, seat_id: seat.seat_id, outcome: "completed" });
} catch (error) {
  await client.unseat({ role: request.role, seat_id: seat.seat_id, outcome: "failed", note: error.message });
  throw error;
}
