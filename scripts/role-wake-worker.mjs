#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { createRemoteRoleSeats } from "../src/role-seats-remote.mjs";
import { getWriteToken } from "../src/write-token.mjs";
import { getRoleWakeCredential, ROLE_WAKE_WORKER } from "../src/role-wake-auth.mjs";

const url = process.env.AGENT_BUS_CONTROL_PLANE_URL || "http://127.0.0.1:18091/agent-bus";
const roleWakeCredential = getRoleWakeCredential();
if (roleWakeCredential?.identity !== ROLE_WAKE_WORKER) throw new Error("Mac role-wake worker credential is required");
const client = createRemoteRoleSeats(url, { writeToken: getWriteToken(), roleWakeCredential });
const worker = `${roleWakeCredential.identity}:${os.hostname()}:${process.pid}`;
const runFile = promisify(execFile);
const desks = {
  "coherence-manager": path.join(os.homedir(), "Documents/Admin/roles/coherence-manager"),
  "estate-operations-manager": path.join(os.homedir(), "Documents/Admin/roles/estate-operations-manager"),
  "estate-architect": path.join(os.homedir(), "Documents/Admin/roles/estate-architect"),
};

function sessionEnv(role, seatToken) {
  const env = { ...process.env, AGENT_BUS_ROLE_SEAT_TOKEN: seatToken };
  delete env.AGENT_BUS_ROLE_WAKE_TOKEN;
  delete env.AGENT_BUS_ROLE_WAKE_TOKEN_FILE;
  delete env.AGENT_BUS_ROLE_WAKE_IDENTITY;
  if (role === "estate-operations-manager" && process.env.AGENT_BUS_EOM_WAKE_TOKEN_FILE) {
    env.AGENT_BUS_ROLE_WAKE_IDENTITY = "estate-operations-manager";
    env.AGENT_BUS_ROLE_WAKE_TOKEN_FILE = process.env.AGENT_BUS_EOM_WAKE_TOKEN_FILE;
  }
  return env;
}

function run(role, prompt, seatToken) {
  let child;
  const completion = new Promise((resolve, reject) => {
    const command = process.env.ROLE_WAKE_CODEX_COMMAND || path.join(os.homedir(), ".npm-global/bin/codex");
    child = spawn(command, ["-a", "never", "exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", desks[role], "-"], { stdio: ["pipe", "inherit", "inherit"], env: sessionEnv(role, seatToken) });
    const maxMs = Number(process.env.ROLE_WAKE_MAX_SESSION_MS || 15 * 60 * 1000);
    const timeout = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); }, maxMs);
    child.once("error", reject); child.once("close", (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`role session exited ${code}`)); });
    child.stdin.end(prompt);
  });
  return { child, completion };
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code === "EPERM"; }
}
function hash(value) { return createHash("sha256").update(String(value)).digest("hex"); }
async function stopRecordedSession(seat) {
  if (!seat.session_pid || !alive(seat.session_pid)) return { session_dead: true, session_identity_verified: Boolean(seat.session_pid), session_token_sha256: seat.session_token_sha256 };
  let command = "";
  try { ({ stdout: command } = await runFile("ps", ["eww", "-p", String(seat.session_pid), "-o", "command="])); } catch { return null; }
  const token = command.match(/(?:^|\s)AGENT_BUS_ROLE_SEAT_TOKEN=([^\s]+)/)?.[1];
  if (!token || hash(token) !== seat.session_token_sha256) return null;
  try { process.kill(seat.session_pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 20 && alive(seat.session_pid); i++) await new Promise((resolve) => setTimeout(resolve, 250));
  if (alive(seat.session_pid)) { try { process.kill(seat.session_pid, "SIGKILL"); } catch {} }
  for (let i = 0; i < 20 && alive(seat.session_pid); i++) await new Promise((resolve) => setTimeout(resolve, 250));
  if (alive(seat.session_pid)) return null;
  return { session_dead: true, session_identity_verified: true, session_token_sha256: seat.session_token_sha256 };
}

const current = await client.list();
const staleMs = Number(process.env.ROLE_WAKE_STALE_AFTER_MS || 180_000);
const recoveryProofs = [];
for (const seat of Object.values(current.seats || {})) {
  if (seat.status !== "occupied" || seat.where !== os.hostname() || seat.worker_id === worker) continue;
  if (Date.now() - new Date(seat.heartbeat_at || seat.since).getTime() < staleMs || alive(seat.worker_pid)) continue;
  const session = await stopRecordedSession(seat);
  if (!session) continue;
  recoveryProofs.push({ role: seat.role, seat_id: seat.seat_id, generation: seat.generation, worker_pid: seat.worker_pid, worker_dead: true, session_pid: seat.session_pid || null, ...session });
}
if (recoveryProofs.length) await client.recover({ worker_id: worker, host: os.hostname(), stale_after_seconds: staleMs / 1000, recovery_proofs: recoveryProofs });
await client.deliverNotes();
const active = new Set();
async function runClaim(claimed) {
  const { request, seat } = claimed;
  const prompt = `You are seated only as ${request.role}. Load that role's canonical skill and run its wake ritual. Consult the explicit Agent Bus seat record ${seat.seat_id}; do not use identity last_seen as occupancy evidence. Work the role queue for: ${request.reason}. Source: ${request.source_ref || "on-demand wake"}. Stay within the role charter; waking grants no new authority. Update the role ledger, then end this bounded seating.`;
  const seatToken = randomBytes(32).toString("hex");
  const { child, completion } = run(request.role, prompt, seatToken);
  try { await client.attachSession({ role: request.role, seat_id: seat.seat_id, generation: seat.generation, worker_id: worker, session_pid: child.pid, session_token: seatToken }); }
  catch (error) { try { child.kill("SIGTERM"); } catch {} throw error; }
  const heartbeat = setInterval(() => void client.heartbeat({ role: request.role, seat_id: seat.seat_id, generation: seat.generation, worker_id: worker }).catch(() => {}), 30_000);
  try {
    await completion;
    await client.unseat({ role: request.role, seat_id: seat.seat_id, generation: seat.generation, worker_id: worker, outcome: "completed" });
  } catch (error) {
    await client.unseat({ role: request.role, seat_id: seat.seat_id, generation: seat.generation, worker_id: worker, outcome: "failed", note: error.message });
  } finally { clearInterval(heartbeat); }
}

let idlePasses = 0;
while (idlePasses < 2 || active.size) {
  const claimed = await client.claim({ worker_id: worker, worker_pid: process.pid, host: os.hostname() });
  if (claimed) {
    idlePasses = 0;
    const task = runClaim(claimed).finally(() => active.delete(task));
    active.add(task);
  } else {
    idlePasses += 1;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}
await Promise.allSettled(active);
