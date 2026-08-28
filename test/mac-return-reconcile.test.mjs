import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

test("return reconciliation emits one offline-window recovery summary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mac-return-"));
  const input = path.join(root, "availability.json");
  const output = path.join(root, "reconciliation.json");
  await fs.writeFile(input, JSON.stringify({ reconciliation: {
    id: "mac-return-test", state: "pending",
    offline_window: { started_at: "2026-08-27T08:00:00Z", ended_at: "2026-08-28T08:00:00Z" },
  }}));
  await run(process.execPath, ["scripts/mac-return-reconcile.mjs", input, output], {
    env: { ...process.env, MAC_RECONCILE_DRY_RUN: "1" },
  });
  const result = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(result.id, "mac-return-test");
  assert.equal(result.state, "completed");
  assert.equal(result.offline_window.started_at, "2026-08-27T08:00:00Z");
  assert.ok(result.recovered.includes("com.antlerforge.agent-bus-a6-tunnel"));
  assert.equal(result.failures.length, 0);
});
