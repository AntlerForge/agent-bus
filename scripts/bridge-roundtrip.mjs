#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRemoteBus } from "../src/remote-bus.mjs";

function parseArgs(argv) {
  const options = {
    artifact: false,
    baseUrl: process.env.AGENT_BUS_CONTROL_PLANE_URL || "http://127.0.0.1:18091/agent-bus",
    targets: [],
    timeoutMs: 5 * 60 * 1000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact") options.artifact = true;
    else if (arg === "--target") options.targets.push(argv[++index]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number.parseInt(argv[++index], 10);
    else if (arg === "--url") options.baseUrl = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run bridge:test -- --target codex --target cursor --target antigravity [--artifact]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.targets.length) options.targets = ["codex", "cursor", "antigravity"];
  return options;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testTarget(client, target, options, tempDirectory) {
  const nonce = `${target.toUpperCase()}_${randomUUID()}`;
  const artifactPaths = [];
  let body = `Reply with the exact nonce ${nonce} and briefly identify your provider surface. Do not modify any files.`;
  if (options.artifact) {
    const artifactPath = path.join(tempDirectory, `${target}-handoff.txt`);
    await writeFile(artifactPath, `ARTIFACT_NONCE=${nonce}\n`, "utf8");
    artifactPaths.push(artifactPath);
    body = "Read the attached handoff file, then include its exact ARTIFACT_NONCE value in your reply. Do not modify any project files.";
  }

  const sentAt = new Date().toISOString();
  const sent = await client.sendMessage({
    from: "bridge-test",
    to: target,
    subject: `Bridge round trip ${nonce}`,
    body,
    ack_required: true,
    requires_response: true,
    artifact_paths: artifactPaths,
    idempotency_key: `bridge-test-${nonce}`,
  });
  const deadline = Date.now() + options.timeoutMs;
  let acknowledged = null;
  let reply = null;
  let thread = null;
  while (Date.now() < deadline) {
    const [targetInbox, testInbox, currentThread] = await Promise.all([
      client.readInbox({ agent: target, include_read: true }),
      client.readInbox({ agent: "bridge-test", include_read: true }),
      client.getThread({ thread_id: sent.thread_id }),
    ]);
    const inbound = targetInbox.find((message) => message.message_id === sent.message_id);
    acknowledged ||= inbound?.acknowledged || null;
    reply = testInbox.find((message) => message.thread_id === sent.thread_id && message.from === target) || null;
    thread = currentThread;
    if (acknowledged && reply && thread.status === "completed") break;
    await wait(1000);
  }
  if (!acknowledged) throw new Error(`${target} did not acknowledge ${sent.message_id}`);
  if (!reply) throw new Error(`${target} did not reply on ${sent.thread_id}`);
  if (!reply.body.includes(nonce)) throw new Error(`${target} reply did not contain nonce ${nonce}: ${reply.body}`);
  if (thread?.status !== "completed") throw new Error(`${target} thread ended as ${thread?.status || "unknown"}`);
  await client.markRead({ message_id: reply.message_id });
  return {
    target,
    message_id: sent.message_id,
    thread_id: sent.thread_id,
    acknowledged,
    completed_at: thread.updated,
    sent_at: sentAt,
    artifact: options.artifact,
    reply: reply.body,
  };
}

const options = parseArgs(process.argv.slice(2));
const client = createRemoteBus(options.baseUrl, { writeToken: process.env.AGENT_BUS_WRITE_TOKEN || null });
await client.registerAgent({
  agent_id: "bridge-test",
  display_name: "Agent Bus Bridge Test",
  type: "test-harness",
  capabilities: ["bridge-round-trip-verification"],
});
const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "agent-bus-roundtrip-"));
try {
  const results = [];
  for (const target of options.targets) {
    results.push(await testTarget(client, target, options, tempDirectory));
  }
  console.log(JSON.stringify({ status: "ok", authority: options.baseUrl, results }, null, 2));
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
