import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  listAmbAgents,
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
