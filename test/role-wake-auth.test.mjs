import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createControlPlane } from "../src/control-plane/server.mjs";
import { parseRoleWakeCredentials } from "../src/role-wake-auth.mjs";

const token = (value) => createHash("sha256").update(value).digest("hex");
const credentials = parseRoleWakeCredentials({ credentials: [
  { identity: "chief-of-staff", kind: "caller", token_sha256: token("cos-secret") },
  { identity: "estate-operations-manager", kind: "caller", token_sha256: token("eom-secret") },
  { identity: "mac-role-wake-worker", kind: "worker", token_sha256: token("worker-secret") },
  { identity: "estate-operations-monitor", kind: "monitor", token_sha256: token("monitor-secret") },
] });

async function withServer(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "role-wake-auth-"));
  const server = createControlPlane({ root, basePath: "/agent-bus", writeToken: "write", roleWakeCredentials: credentials });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}/agent-bus`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function post(base, route, body, identity, wakeToken) {
  return fetch(base + route, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer write", ...(identity ? { "x-agent-bus-role-wake-identity": identity, "x-agent-bus-role-wake-token": wakeToken } : {}) }, body: JSON.stringify(body) });
}

test("wake endpoint requires a scoped caller credential and binds audited identity to it", async () => withServer(async (base) => {
  assert.equal((await post(base, "/api/v1/role-seats/wake", { role: "coherence-manager", reason: "review" })).status, 401);
  const response = await post(base, "/api/v1/role-seats/wake", { role: "coherence-manager", reason: "review", requested_by: "tony" }, "chief-of-staff", "cos-secret");
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.request.requested_by, "chief-of-staff");
}));

test("worker and monitor credentials cannot exercise caller scope", async () => withServer(async (base) => {
  assert.equal((await post(base, "/api/v1/role-seats/wake", { role: "coherence-manager", reason: "review" }, "mac-role-wake-worker", "worker-secret")).status, 401);
  const signal = await post(base, "/api/v1/role-seats/signal", { signal_type: "stalled_work", signal_key: "stalled:a", reason: "one unread response", source_ref: "test" }, "estate-operations-monitor", "monitor-secret");
  assert.equal(signal.status, 200);
  assert.equal((await signal.json()).request.role, "estate-operations-manager");
}));
