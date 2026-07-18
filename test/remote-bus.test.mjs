import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createControlPlane } from "../src/control-plane/server.mjs";
import { ensureBusLayout } from "../src/paths.mjs";
import { createRemoteBus } from "../src/remote-bus.mjs";

test("remote Agent Bus client keeps messages and threads on the control-plane authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-bus-remote-test-"));
  await ensureBusLayout(root);
  const server = createControlPlane({ root, basePath: "/agent-bus", writeToken: "secret" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = createRemoteBus(`http://127.0.0.1:${server.address().port}/agent-bus`, { writeToken: "secret" });
  try {
    const sent = await client.sendMessage({ from: "claude", to: "codex", subject: "Remote", body: "Central message", requires_response: true });
    const inbox = await client.readInbox({ agent: "codex" });
    assert.equal(inbox[0].message_id, sent.message_id);
    await client.ackMessage({ message_id: sent.message_id });
    const reply = await client.replyMessage({ from: "codex", to: "claude", thread_id: sent.thread_id, body: "Central reply" });
    assert.equal(reply.seq, 2);
    await client.markRead({ message_id: sent.message_id });
    await client.updateThreadStatus({ thread_id: sent.thread_id, status: "completed" });
    assert.equal((await client.listThreads())[0].status, "completed");
    assert.match((await client.getThread({ thread_id: sent.thread_id })).body, /Central reply/);
    assert.ok((await client.listAgents()).find((agent) => agent.agent_id === "cursor"));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});

test("remote Agent Bus uploads and materializes host-local artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-bus-remote-artifact-test-"));
  const clientRoot = await mkdtemp(path.join(os.tmpdir(), "agent-bus-remote-client-test-"));
  await ensureBusLayout(root);
  const server = createControlPlane({ root, basePath: "/agent-bus", writeToken: "secret" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = createRemoteBus(`http://127.0.0.1:${server.address().port}/agent-bus`, { writeToken: "secret" });
  try {
    const source = path.join(clientRoot, "handoff.txt");
    await writeFile(source, "artifact-round-trip", "utf8");
    const sent = await client.sendMessage({
      from: "claude",
      to: "cursor",
      subject: "Artifact",
      body: "Read the attached file",
      artifact_paths: [source],
      requires_response: true,
    });
    const [message] = await client.readInbox({ agent: "cursor" });
    assert.equal(message.message_id, sent.message_id);
    assert.equal(message.artifacts.length, 1);
    assert.match(message.artifact_paths[0], /shared\/uploads/);
    const materialized = await client.materializeMessageArtifacts(message, path.join(clientRoot, "downloads"));
    assert.equal(materialized.length, 1);
    assert.equal(await readFile(materialized[0].local_path, "utf8"), "artifact-round-trip");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
    await rm(clientRoot, { recursive: true, force: true });
  }
});
