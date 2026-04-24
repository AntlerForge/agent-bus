import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readArtifactManifest } from "../src/artifacts.mjs";
import { listAgents, registerAgent } from "../src/agents.mjs";
import {
  ackMessage,
  listThreads,
  markRead,
  readInbox,
  replyMessage,
  sendMessage,
  updateThreadStatus,
} from "../src/mailbox.mjs";
import { parseMarkdownWithFrontmatter } from "../src/markdown.mjs";
import { ensureBusLayout, getPaths } from "../src/paths.mjs";

async function withBusRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-bus-test-"));
  try {
    await ensureBusLayout(root);
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("sendMessage creates inbox and thread files", async () => {
  await withBusRoot(async (root) => {
    const result = await sendMessage(
      {
        from: "claude",
        to: "codex",
        subject: "Review design",
        body: "Please review this.",
        ack_required: true,
        requires_response: true,
      },
      root,
    );

    assert.equal(result.seq, 1);
    assert.match(result.message_id, /^msg_/);
    assert.match(result.thread_id, /^thread_/);

    const inbox = await readInbox({ agent: "codex" }, root);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].from, "claude");
    assert.equal(inbox[0].status, "unread");
    assert.equal(inbox[0].ack_required, true);
    assert.equal(inbox[0].requires_response, true);

    const threads = await listThreads(root);
    assert.equal(threads.length, 1);
    assert.equal(threads[0].status, "open");
    assert.equal(threads[0].next_seq, 2);
  });
});

test("reply increments thread sequence and creates recipient inbox message", async () => {
  await withBusRoot(async (root) => {
    const first = await sendMessage(
      { from: "claude", to: "codex", subject: "Question", body: "Can you answer?" },
      root,
    );
    const reply = await replyMessage(
      { from: "codex", to: "claude", thread_id: first.thread_id, body: "Yes.", requires_response: false },
      root,
    );

    assert.equal(reply.seq, 2);
    const claudeInbox = await readInbox({ agent: "claude" }, root);
    assert.equal(claudeInbox.length, 1);
    assert.equal(claudeInbox[0].thread_id, first.thread_id);

    const threads = await listThreads(root);
    assert.equal(threads[0].next_seq, 3);
  });
});

test("ackMessage and markRead update message frontmatter in place", async () => {
  await withBusRoot(async (root) => {
    const sent = await sendMessage(
      { from: "claude", to: "codex", subject: "Ack me", body: "Please ack." },
      root,
    );

    const acked = await ackMessage({ message_id: sent.message_id }, root);
    assert.equal(acked.status, "acknowledged");

    const read = await markRead({ message_id: sent.message_id }, root);
    assert.equal(read.status, "read");

    const raw = await readFile(sent.inbox_file, "utf8");
    const { data } = parseMarkdownWithFrontmatter(raw);
    assert.equal(data.status, "read");
    assert.ok(data.acknowledged);
    assert.ok(data.read);

    const unread = await readInbox({ agent: "codex" }, root);
    assert.equal(unread.length, 0);
    const all = await readInbox({ agent: "codex", include_read: true }, root);
    assert.equal(all.length, 1);
  });
});

test("updateThreadStatus records lifecycle status", async () => {
  await withBusRoot(async (root) => {
    const sent = await sendMessage(
      { from: "claude", to: "codex", subject: "Status", body: "Track this." },
      root,
    );

    const updated = await updateThreadStatus({ thread_id: sent.thread_id, status: "completed" }, root);
    assert.equal(updated.status, "completed");

    const threads = await listThreads(root);
    assert.equal(threads[0].status, "completed");
  });
});

test("idempotency key deduplicates send retries", async () => {
  await withBusRoot(async (root) => {
    const args = {
      from: "claude",
      to: "codex",
      subject: "Retry",
      body: "Send once.",
      idempotency_key: "retry-key-1",
    };
    const first = await sendMessage(args, root);
    const second = await sendMessage(args, root);

    assert.equal(second.deduplicated, true);
    assert.equal(second.message_id, first.message_id);

    const inbox = await readInbox({ agent: "codex" }, root);
    assert.equal(inbox.length, 1);
  });
});

test("artifacts are registered only from the shared folder", async () => {
  await withBusRoot(async (root) => {
    const paths = getPaths(root);
    const artifactPath = path.join(paths.shared, "design.md");
    await writeFile(artifactPath, "# Design\n", "utf8");

    const sent = await sendMessage(
      {
        from: "claude",
        to: "codex",
        subject: "Artifact",
        body: "See artifact.",
        artifact_paths: [artifactPath],
      },
      root,
    );

    assert.equal(sent.artifacts.length, 1);
    const manifest = await readArtifactManifest(root);
    assert.equal(manifest.artifacts.length, 1);
    assert.equal(manifest.artifacts[0].path, artifactPath);

    await assert.rejects(
      () =>
        sendMessage(
          {
            from: "claude",
            to: "codex",
            subject: "Bad artifact",
            body: "No.",
            artifact_paths: [path.join(root, "outside.md")],
          },
          root,
        ),
      /Shared artifact path must be inside/,
    );
  });
});

test("obvious secrets are blocked", async () => {
  await withBusRoot(async (root) => {
    await assert.rejects(
      () =>
        sendMessage(
          {
            from: "claude",
            to: "codex",
            subject: "Secret",
            body: "api_key = abcdefghijklmnopqrstuvwxyz",
          },
          root,
        ),
      /appears to contain a secret/,
    );
  });
});

test("agent registry bootstraps defaults and registers new agents", async () => {
  await withBusRoot(async (root) => {
    const defaults = await listAgents(root);
    assert.ok(defaults.find((agent) => agent.agent_id === "claude"));
    assert.ok(defaults.find((agent) => agent.agent_id === "codex"));

    const agent = await registerAgent(
      { agent_id: "reviewer", display_name: "Reviewer", type: "test", capabilities: ["review"] },
      root,
    );
    assert.equal(agent.display_name, "Reviewer");
    assert.ok(agent.last_seen);
  });
});
