import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { processAlive, stopRecordedRoleSession } from "../src/role-wake-worker-runtime.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("worker recovery verifies the real child PID marker and proves it dead", async () => {
  const token = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: { ...process.env, AGENT_BUS_ROLE_SEAT_TOKEN: token }, stdio: "ignore" });
  await pause(100);
  assert.equal(processAlive(child.pid), true);
  const proof = await stopRecordedRoleSession({ session_pid: child.pid, session_token_sha256: digest(token) }, { wait_ms: 20 });
  assert.deepEqual(proof, { session_dead: true, session_identity_verified: true, session_token_sha256: digest(token) });
  assert.equal(processAlive(child.pid), false);
});

test("worker recovery refuses a live child whose PID marker does not match", async (t) => {
  const token = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: { ...process.env, AGENT_BUS_ROLE_SEAT_TOKEN: token }, stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  await pause(100);
  assert.equal(await stopRecordedRoleSession({ session_pid: child.pid, session_token_sha256: digest("wrong") }, { wait_ms: 20 }), null);
  assert.equal(processAlive(child.pid), true);
});
