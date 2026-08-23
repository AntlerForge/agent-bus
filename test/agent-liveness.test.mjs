import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { classifyLiveness, heartbeatAgent, readAgents, LIVENESS_THRESHOLDS } from "../src/agents.mjs";
import { buildHeartbeatArgs } from "../src/runtime-bridge.mjs";
import { createControlPlane } from "../src/control-plane/server.mjs";
import { ensureBusLayout } from "../src/paths.mjs";

async function withBusRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-liveness-test-"));
  await ensureBusLayout(root);
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withControlPlane(fn, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-liveness-cp-test-"));
  await ensureBusLayout(root);
  const server = createControlPlane({ root, writeToken: "test-token", ...options });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`, root);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
}

test("classifyLiveness applies fresh, stale, down and unknown thresholds", () => {
  const now = Date.parse("2026-08-11T12:00:00Z");
  const secondsAgo = (seconds) => new Date(now - seconds * 1000).toISOString();
  assert.equal(classifyLiveness(null, now), "unknown");
  assert.equal(classifyLiveness("not a date", now), "unknown");
  assert.equal(classifyLiveness(secondsAgo(30), now), "fresh");
  assert.equal(classifyLiveness(secondsAgo(LIVENESS_THRESHOLDS.fresh_seconds - 1), now), "fresh");
  assert.equal(classifyLiveness(secondsAgo(LIVENESS_THRESHOLDS.fresh_seconds), now), "stale");
  assert.equal(classifyLiveness(secondsAgo(LIVENESS_THRESHOLDS.stale_seconds - 1), now), "stale");
  assert.equal(classifyLiveness(secondsAgo(LIVENESS_THRESHOLDS.stale_seconds), now), "down");
});

test("heartbeatAgent persists liveness on the agent record with atomic writes", async () => {
  await withBusRoot(async (root) => {
    const updated = await heartbeatAgent({
      agent_id: "cursor",
      host: "mac.local",
      pid: 4321,
      bridge_version: "1.0.0",
      state: "working:thread_demo",
      queue_depth: 2,
    }, root);
    assert.equal(updated.liveness.state, "working:thread_demo");
    assert.equal(updated.liveness.current_thread_id, "thread_demo");
    assert.equal(updated.liveness.queue_depth, 2);
    assert.equal(updated.liveness.host, "mac.local");
    assert.equal(updated.liveness.pid, 4321);
    assert.ok(updated.liveness.last_heartbeat);
    const persisted = await readAgents(root);
    assert.equal(persisted.cursor.liveness.state, "working:thread_demo");
    assert.equal(persisted.cursor.last_seen, updated.liveness.last_heartbeat);
  });
});

test("heartbeatAgent rejects malformed states and missing agent ids", async () => {
  await withBusRoot(async (root) => {
    await assert.rejects(() => heartbeatAgent({ agent_id: "cursor", state: "busy" }, root), /state must be/);
    await assert.rejects(() => heartbeatAgent({ state: "idle" }, root), /agent_id is required/);
  });
});

test("buildHeartbeatArgs reports the bridge host, pid and state", () => {
  const args = buildHeartbeatArgs({ agentId: "cursor", state: "working:thread_x", queueDepth: 3, version: "1.0.0" });
  assert.equal(args.agent_id, "cursor");
  assert.equal(args.host, os.hostname());
  assert.equal(args.pid, process.pid);
  assert.equal(args.state, "working:thread_x");
  assert.equal(args.queue_depth, 3);
  assert.equal(args.bridge_version, "1.0.0");
});

test("control plane accepts heartbeats and serves the agents status API", async () => {
  await withControlPlane(async (base) => {
    const heartbeat = await fetch(`${base}/api/v1/agents/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({
        agent_id: "cursor",
        host: "mac.local",
        pid: 987,
        bridge_version: "1.0.0",
        state: "working:thread_live",
        queue_depth: 1,
      }),
    });
    assert.equal(heartbeat.status, 200);

    const statusResponse = await fetch(`${base}/api/v1/agents/status`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.schema_version, 1);
    assert.deepEqual(status.thresholds, LIVENESS_THRESHOLDS);
    const cursor = status.agents.find((agent) => agent.agent_id === "cursor");
    assert.equal(cursor.liveness, "fresh");
    assert.equal(cursor.state, "working:thread_live");
    assert.equal(cursor.current_thread_id, "thread_live");
    assert.equal(cursor.queue_depth, 1);
    assert.equal(cursor.host, "mac.local");
    const codex = status.agents.find((agent) => agent.agent_id === "codex");
    assert.equal(codex.liveness, "unknown");
    assert.equal(codex.state, "unknown");

    const alias = await fetch(`${base}/api/agents/status`);
    assert.equal(alias.status, 200);

    const invalid = await fetch(`${base}/api/v1/agents/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ agent_id: "cursor", state: "busy" }),
    });
    assert.equal(invalid.status, 400);
  });
});

test("agent lifecycle endpoint stands agents down and reactivates them", async () => {
  await withControlPlane(async (base) => {
    const retire = await fetch(`${base}/api/v1/agents/codex/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ status: "retired", actor: "tony" }),
    });
    assert.equal(retire.status, 200);
    const retired = await retire.json();
    assert.equal(retired.lifecycle_status, "retired");
    assert.equal(retired.lifecycle_changed_by, "tony");

    const status = await (await fetch(`${base}/api/v1/agents/status`)).json();
    const codex = status.agents.find((agent) => agent.agent_id === "codex");
    assert.equal(codex.lifecycle_status, "retired");
    assert.equal(codex.connection, "bridge");

    const reactivate = await fetch(`${base}/api/v1/agents/codex/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ status: "active", actor: "tony" }),
    });
    assert.equal((await reactivate.json()).lifecycle_status, "active");

    const invalid = await fetch(`${base}/api/v1/agents/codex/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ status: "gone" }),
    });
    assert.equal(invalid.status, 400);
    const missing = await fetch(`${base}/api/v1/agents/nobody/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ status: "retired" }),
    });
    assert.equal(missing.status, 404);
  });
});

test("heartbeat endpoint honours the write token while status stays readable", async () => {
  await withControlPlane(async (base) => {
    const denied = await fetch(`${base}/api/v1/agents/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "cursor", state: "idle" }),
    });
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${base}/api/v1/agents/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ agent_id: "cursor", state: "idle" }),
    });
    assert.equal(allowed.status, 200);
    assert.equal((await fetch(`${base}/api/v1/agents/status`)).status, 200);
  }, { writeToken: "test-token" });
});
