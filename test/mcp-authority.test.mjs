import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("MCP entry point fails closed without an explicit authority", () => {
  const env = { ...process.env };
  delete env.AGENT_BUS_CONTROL_PLANE_URL;
  delete env.AGENT_BUS_ALLOW_LOCAL;
  const result = spawnSync(process.execPath, ["src/server.mjs"], { env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authority is not configured/);
});
