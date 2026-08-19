import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  listAmbAgents,
  findAmbAgents,
  markAmbMessageRead,
  readAmbInbox,
  registerAmbAgent,
  retireAmbAgent,
  sendAmbMessage,
} from "../src/amb-board.mjs";
import { listAgents, registerAgent } from "../src/agents.mjs";
import { readInbox, sendMessage } from "../src/mailbox.mjs";
import { ensureBusLayout, getPaths } from "../src/paths.mjs";

async function withRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "amb-board-test-"));
  await ensureBusLayout(root);
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("AMB registry, mailbox and read lifecycle are passive and human-readable", async () => {
  await withRoot(async (root) => {
    assert.deepEqual(await listAmbAgents({}, root), []);
    await registerAmbAgent({ agent_id: "chief-of-staff", role: "Routes and triages" }, root);
    await registerAmbAgent({ agent_id: "DadCare", role: "Maintains Dad care context" }, root);
    const sent = await sendAmbMessage({
      from: "chief-of-staff",
      to: "DadCare",
      body: "Context is at /srv/kv/vault/family/dad/context.md",
    }, root);

    const unread = await readAmbInbox({ agent: "DadCare" }, root);
    assert.equal(unread.length, 1);
    assert.equal(unread[0].body, "Context is at /srv/kv/vault/family/dad/context.md");
    assert.equal(unread[0].status, "unread");

    await markAmbMessageRead({ agent: "DadCare", message_id: sent.message_id }, root);
    assert.deepEqual(await readAmbInbox({ agent: "DadCare" }, root), []);
    const all = await readAmbInbox({ agent: "DadCare", include_read: true }, root);
    assert.equal(all[0].status, "read");
    assert.ok(all[0].read_at);

    const paths = getPaths(root);
    const stored = JSON.parse(await readFile(path.join(paths.ambInbox, "DadCare", `${sent.message_id}.json`), "utf8"));
    assert.equal(stored.body, unread[0].body);
  });
});

test("legacy AMB registrations remain readable and refresh without data loss", async () => {
  await withRoot(async (root) => {
    const paths = getPaths(root);
    await writeFile(paths.ambAgentsFile, JSON.stringify({
      legacy: {
        agent_id: "legacy",
        display_name: "Legacy Agent",
        role: "Keeps old context",
        lifecycle_status: "active",
        registered_at: "2026-08-01T10:00:00Z",
        updated_at: "2026-08-02T10:00:00Z",
      },
    }));
    const [before] = await listAmbAgents({}, root);
    assert.equal(before.role, "Keeps old context");
    assert.equal(before.recent_work, "");
    assert.deepEqual(before.tags, []);
    assert.equal(before.last_active_at, "2026-08-02T10:00:00Z");

    const after = await registerAmbAgent({
      agent_id: "legacy",
      recent_work: "GitHub repository rationalisation",
      tags: ["github", "repositories"],
      chat_locator: "Codex thread legacy-chat",
    }, root);
    assert.equal(after.role, "Keeps old context");
    assert.equal(after.registered_at, "2026-08-01T10:00:00Z");
    assert.equal(after.recent_work, "GitHub repository rationalisation");
    assert.ok(after.last_active_at);
  });
});

test("AMB topic lookup ranks deterministically and exposes ambiguity", async () => {
  await withRoot(async (root) => {
    await registerAmbAgent({
      agent_id: "repo-one",
      role: "Maintains software repositories",
      recent_work: "GitHub repository rationalisation and archive review",
      tags: ["github", "repository", "rationalisation"],
      chat_locator: "Codex thread repo-one-chat",
    }, root);
    await registerAmbAgent({
      agent_id: "repo-two",
      role: "Maintains software repositories",
      recent_work: "GitHub repository rationalisation for personal projects",
      tags: ["github", "repository", "rationalisation"],
      chat_locator: "Claude session repo-two-chat",
    }, root);
    await registerAmbAgent({
      agent_id: "dad-care",
      role: "Maintains Dad care context",
      recent_work: "SystmOnline medical record filing",
      tags: ["dad", "medical"],
      chat_locator: "Codex thread dad-care-chat",
    }, root);

    const ambiguous = await findAmbAgents({ query: "github repository rationalisation" }, root);
    assert.equal(ambiguous.ambiguous, true);
    assert.deepEqual(new Set(ambiguous.results.map((agent) => agent.agent_id)), new Set(["repo-one", "repo-two"]));
    assert.ok(ambiguous.results.every((agent) => agent.chat_locator.includes("chat")));

    const unique = await findAmbAgents({ query: "archive review" }, root);
    assert.equal(unique.ambiguous, false);
    assert.equal(unique.results[0].agent_id, "repo-one");
    assert.deepEqual((await findAmbAgents({ query: "wedding venue" }, root)).results, []);
  });
});

test("Agent Bus traffic and lifecycle never cross the AMB boundary", async () => {
  await withRoot(async (root) => {
    await registerAmbAgent({ agent_id: "chief-of-staff", role: "Routes and triages" }, root);
    await registerAmbAgent({ agent_id: "DadCare", role: "Maintains Dad care context" }, root);
    await registerAgent({ agent_id: "DadCare", display_name: "DadCare Bus Target", type: "agent" }, root);

    await sendMessage({
      from: "codex",
      to: "DadCare",
      subject: "Agent Bus operational message",
      body: "This must never appear on AMB.",
      intent: "inform",
    }, root);
    await sendAmbMessage({
      from: "chief-of-staff",
      to: "DadCare",
      body: "This is the passive AMB note.",
    }, root);

    const ambMessages = await readAmbInbox({ agent: "DadCare", include_read: true }, root);
    assert.deepEqual(ambMessages.map((message) => message.body), ["This is the passive AMB note."]);
    const busMessages = await readInbox({ agent: "DadCare", include_read: true }, root);
    assert.deepEqual(busMessages.map((message) => message.subject), ["Agent Bus operational message"]);

    await retireAmbAgent({ agent_id: "DadCare", actor: "chief-of-staff" }, root);
    const busAgent = (await listAgents(root)).find((agent) => agent.agent_id === "DadCare");
    assert.notEqual(busAgent.lifecycle_status, "retired");
    assert.equal((await listAmbAgents({ include_retired: true }, root)).find((agent) => agent.agent_id === "DadCare").lifecycle_status, "retired");
  });
});
