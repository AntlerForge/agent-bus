import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createControlPlane } from "../src/control-plane/server.mjs";
import { ensureBusLayout } from "../src/paths.mjs";
import { createRemoteWorkLedger } from "../src/work-ledger/remote.mjs";

test("remote work-ledger client keeps MCP operations on the control-plane authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-ledger-remote-test-"));
  await ensureBusLayout(root);
  const server = createControlPlane({ root, basePath: "/agent-bus", writeToken: "secret" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const client = createRemoteWorkLedger(`http://127.0.0.1:${port}/agent-bus`, { writeToken: "secret" });
    const created = await client.createWorkItem({
      title: "Remote task",
      objective: "Keep one A6 task authority.",
      source_ref: "BL119",
      proposed_by: "codex",
    });
    assert.equal(created.status, "proposed");
    assert.equal((await client.listWorkItems({ status: "proposed" }))[0].work_item_id, created.work_item_id);
    const detail = await client.getWorkItem({ work_item_id: created.work_item_id });
    assert.equal(detail.item.title, "Remote task");
    assert.equal(detail.events[0].actor, "codex");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
