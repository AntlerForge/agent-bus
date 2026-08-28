import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluateWrapper, inspectWrappers } from "../scripts/mac-wrapper-liveness.mjs";

test("running wrapper is stale only after its output cadence expires", () => {
  const nowMs = Date.parse("2026-08-28T12:00:00Z");
  assert.equal(evaluateWrapper({ running: true, outputMtimeMs: nowMs - 151 * 60000, nowMs, maxOutputAgeMinutes: 150 }).stale, true);
  assert.equal(evaluateWrapper({ running: true, outputMtimeMs: nowMs - 149 * 60000, nowMs, maxOutputAgeMinutes: 150 }).stale, false);
  assert.equal(evaluateWrapper({ running: false, outputMtimeMs: nowMs - 999 * 60000, nowMs, maxOutputAgeMinutes: 150 }).stale, false);
});

test("stale resident wrapper is restarted through its declared LaunchAgent", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wrapper-liveness-"));
  const outputPath = path.join(home, "wrapper.log");
  await fs.writeFile(outputPath, "old output\n");
  const nowMs = Date.parse("2026-08-28T12:00:00Z");
  await fs.utimes(outputPath, new Date(nowMs - 181 * 60000), new Date(nowMs - 181 * 60000));
  const calls = [];
  const [result] = inspectWrappers({
    home,
    nowMs,
    wrappers: [{ id: "test", processNeedle: "/Test.app/applet", outputPath: "wrapper.log", maxOutputAgeMinutes: 180, launchdLabel: "com.test.wrapper" }],
    processList: [{ pid: 4242, command: "/Test.app/applet" }],
    restartFn: (...args) => calls.push(args),
  });
  assert.equal(result.action, "restarted");
  assert.deepEqual(result.pids, [4242]);
  assert.equal(calls[0][0].launchdLabel, "com.test.wrapper");
});
