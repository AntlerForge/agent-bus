import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createControlPlane } from "../src/control-plane/server.mjs";
import { ensureBusLayout } from "../src/paths.mjs";
import { writeSelectorFixture } from "./selector-fixture.mjs";

async function withControlPlane(fn, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-control-plane-test-"));
  await ensureBusLayout(root);
  const server = createControlPlane({ root, ...options });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
}

test("control plane serves dashboard, health and version", async () => {
  await withControlPlane(async (base) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.status, "ok");
    const version = await fetch(`${base}/version`);
    assert.equal((await version.json()).version, "0.4.0");
    const dashboard = await fetch(base);
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /Agent Control Plane/);
  });
});

test("control plane can be mounted under a private reverse-proxy base path", async () => {
  await withControlPlane(async (base) => {
    const dashboard = await fetch(`${base}/agent-bus/`);
    assert.equal(dashboard.status, 200);
    const html = await dashboard.text();
    assert.match(html, /content="\/agent-bus"/);
    assert.match(html, /href="\/agent-bus\/styles.css"/);
    assert.equal((await fetch(`${base}/agent-bus/api/v1/overview`)).status, 200);
  }, { basePath: "/agent-bus" });
});

test("structured request logging suppresses successful health and inbox polling noise", async () => {
  const records = [];
  await withControlPlane(async (base) => {
    await fetch(`${base}/healthz`);
    await fetch(`${base}/api/v1/inbox?agent=codex`);
    await fetch(`${base}/api/v1/work-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Logged write", objective: "Keep mutations visible.", source_ref: "BL119" }),
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].method, "POST");
  }, { logger: (record) => records.push(record) });
});

test("work item API creates, promotes and returns auditable detail", async () => {
  await withControlPlane(async (base) => {
    const createdResponse = await fetch(`${base}/api/v1/work-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "API task", objective: "Prove the API lifecycle.", source_ref: "BL119" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const promoted = await fetch(`${base}/api/v1/work-items/${created.work_item_id}/transition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ready", actor: "tony" }),
    });
    assert.equal((await promoted.json()).status, "ready");
    const detail = await fetch(`${base}/api/v1/work-items/${created.work_item_id}`);
    const payload = await detail.json();
    assert.equal(payload.item.source_ref, "BL119");
    assert.deepEqual(payload.events.map((event) => event.type), ["work_item_created", "status_changed"]);
  });
});

test("optional write token protects mutations but not dashboard reads", async () => {
  await withControlPlane(async (base) => {
    assert.equal((await fetch(`${base}/api/v1/overview`)).status, 200);
    const denied = await fetch(`${base}/api/v1/work-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "No", objective: "Denied", source_ref: "BL119" }),
    });
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${base}/api/v1/work-items`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ title: "Yes", objective: "Allowed", source_ref: "BL119" }),
    });
    assert.equal(allowed.status, 201);
  }, { writeToken: "test-token" });
});

test("control plane exposes selector guidance and creates gated workflow proposals", async () => {
  const selectorPath = await mkdtemp(path.join(os.tmpdir(), "agent-selector-control-plane-"));
  await writeSelectorFixture(selectorPath);
  try {
    await withControlPlane(async (base) => {
      const selectorResponse = await fetch(`${base}/api/v1/model-selector`);
      assert.equal(selectorResponse.status, 200);
      const selector = await selectorResponse.json();
      assert.equal(selector.status, "current");
      assert.equal(selector.workflow_templates[0].template_id, "panel");

      const proposedResponse = await fetch(`${base}/api/v1/model-selector/templates/panel/propose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "Chapter 38", source_ref: "book:chapter-38", project: "the-correction", proposed_by: "codex" }),
      });
      assert.equal(proposedResponse.status, 201);
      const proposed = await proposedResponse.json();
      assert.equal(proposed.created.length, 2);
      assert.ok(proposed.created.every((item) => item.status === "proposed"));
      assert.ok(proposed.created.every((item) => item.current_assignment === null));

      const overview = await (await fetch(`${base}/api/v1/overview`)).json();
      assert.equal(overview.selector.status, "current");
      assert.equal(overview.counts.proposed, 2);
    }, { selectorPath });
  } finally {
    await rm(selectorPath, { recursive: true, force: true });
  }
});
