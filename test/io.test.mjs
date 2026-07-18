import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileAtomic } from "../src/io.mjs";

test("concurrent atomic state writes never expose a missing or partial target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-atomic-test-"));
  const target = path.join(root, "_agents.json");
  try {
    await Promise.all(Array.from({ length: 100 }, (_, index) => writeFileAtomic(target, JSON.stringify({ index, payload: "x".repeat(1024) }))));
    const parsed = JSON.parse(await readFile(target, "utf8"));
    assert.equal(typeof parsed.index, "number");
    assert.equal(parsed.payload.length, 1024);
  } finally { await rm(root, { recursive: true, force: true }); }
});
