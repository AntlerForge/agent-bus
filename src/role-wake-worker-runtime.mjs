import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function hash(value) { return createHash("sha256").update(String(value)).digest("hex"); }

export async function stopRecordedRoleSession(seat, { inspect = runFile, alive = processAlive, kill = process.kill.bind(process), wait_ms = 250 } = {}) {
  if (!seat.session_pid || !alive(seat.session_pid)) {
    return { session_dead: true, session_identity_verified: Boolean(seat.session_pid), session_token_sha256: seat.session_token_sha256 };
  }
  let command = "";
  try { ({ stdout: command } = await inspect("ps", ["eww", "-p", String(seat.session_pid), "-o", "command="])); } catch { return null; }
  const token = command.match(/(?:^|\s)AGENT_BUS_ROLE_SEAT_TOKEN=([^\s]+)/)?.[1];
  if (!token || hash(token) !== seat.session_token_sha256) return null;
  try { kill(seat.session_pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 20 && alive(seat.session_pid); i++) await new Promise((resolve) => setTimeout(resolve, wait_ms));
  if (alive(seat.session_pid)) { try { kill(seat.session_pid, "SIGKILL"); } catch {} }
  for (let i = 0; i < 20 && alive(seat.session_pid); i++) await new Promise((resolve) => setTimeout(resolve, wait_ms));
  if (alive(seat.session_pid)) return null;
  return { session_dead: true, session_identity_verified: true, session_token_sha256: seat.session_token_sha256 };
}
