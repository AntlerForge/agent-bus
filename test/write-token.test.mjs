import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getWriteToken } from "../src/write-token.mjs";

test("write token loads from the coordinated runtime file and env wins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-bus-token-"));
  const tokenFile = path.join(root, "write-token.env");
  try {
    await writeFile(tokenFile, "AGENT_BUS_WRITE_TOKEN=file-secret\n", { mode: 0o600 });
    assert.equal(getWriteToken({ AGENT_BUS_WRITE_TOKEN_FILE: tokenFile }), "file-secret");
    assert.equal(getWriteToken({ AGENT_BUS_WRITE_TOKEN: "env-secret", AGENT_BUS_WRITE_TOKEN_FILE: tokenFile }), "env-secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
