import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { createControlPlane } from "../src/control-plane/server.mjs";
import { ensureBusLayout } from "../src/paths.mjs";

const execFileAsync = promisify(execFile);
const AMB = path.resolve("bin/amb");

async function withControlPlane(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "amb-cli-root-"));
  const homes = await mkdtemp(path.join(os.tmpdir(), "amb-cli-homes-"));
  await ensureBusLayout(root);
  const server = createControlPlane({ root, basePath: "/agent-bus", writeToken: "test-token" });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}/agent-bus`;
  async function amb(home, args, extraEnv = {}) {
    return execFileAsync("python3", [AMB, ...args], {
      env: { ...process.env, AMB_URL: base, AMB_TOKEN: "test-token", AMB_HOME: path.join(homes, home), ...extraEnv },
    });
  }
  try {
    await fn({ amb, base });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
    await rm(homes, { recursive: true, force: true });
  }
}

test("AMB CLI implements the separate passive board user flow", async () => {
  await withControlPlane(async ({ amb, base }) => {
    assert.match((await amb("cos", ["status"])).stdout, /No agents registered on AMB/);
    await amb("cos", ["add", "chief-of-staff", "--role", "Routes and triages", "--recent-work", "GitHub repository rationalisation", "--tags", "github,repository", "--chat", "Codex thread cos-chat"]);
    await amb("dad", ["add", "DadCare", "--role", "Maintains Dad care context"]);

    const status = (await amb("cos", ["status"])).stdout;
    assert.match(status, /chief-of-staff\s+Routes and triages/);
    assert.match(status, /DadCare\s+Maintains Dad care context/);
    assert.doesNotMatch(status, /QUEUE|WORKING ON|HEARTBEAT/);

    const found = (await amb("dad", ["find", "github", "repository"])).stdout;
    assert.match(found, /chief-of-staff\s+GitHub repository rationalisation\s+Codex thread cos-chat/);
    assert.match(found, /Best match: chief-of-staff/);

    await amb("cos", ["refresh", "--recent-work", "Agent repository cleanup", "--tags", "repository,cleanup", "--chat", "Codex thread refreshed-chat"]);
    const refreshed = (await amb("dad", ["who", "chief-of-staff"])).stdout;
    assert.match(refreshed, /RECENT WORK: Agent repository cleanup/);
    assert.match(refreshed, /CHAT: Codex thread refreshed-chat/);

    await fetch(`${base}/api/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "codex",
        to: "DadCare",
        subject: "Agent Bus only",
        body: "This must not leak into AMB.",
        intent: "inform",
      }),
    });
    const note = "Dad context: /srv/kv/vault/family/dad/context.md";
    await amb("cos", ["message", "DadCare", note]);
    const firstRead = (await amb("dad", ["read"])).stdout;
    assert.match(firstRead, /from chief-of-staff/);
    assert.match(firstRead, /Dad context: \/srv\/kv\/vault\/family\/dad\/context\.md/);
    assert.doesNotMatch(firstRead, /Agent Bus only|must not leak/);
    assert.match((await amb("dad", ["read"])).stdout, /No unread messages/);
    const all = (await amb("dad", ["read", "--all"])).stdout;
    assert.match(all, /Dad context/);
    assert.doesNotMatch(all, /Agent Bus only|must not leak/);

    const who = (await amb("dad", ["who", "DadCare"])).stdout;
    assert.match(who, /ROLE: Maintains Dad care context/);
    assert.doesNotMatch(who, /capabilit|queue|heartbeat/i);

    await amb("cos", ["retire", "DadCare"]);
    assert.doesNotMatch((await amb("cos", ["status"])).stdout, /DadCare/);
    const busAgents = await (await fetch(`${base}/api/v1/agents`)).json();
    assert.ok(busAgents.find((agent) => agent.agent_id === "DadCare") === undefined);
  });
});

test("AMB CLI refuses empty and ambiguous topic routing", async () => {
  await withControlPlane(async ({ amb }) => {
    await amb("one", ["add", "repo-one", "--role", "Repository agent", "--recent-work", "GitHub repository rationalisation", "--tags", "github,repository", "--chat", "Codex thread one"]);
    await amb("two", ["add", "repo-two", "--role", "Repository agent", "--recent-work", "GitHub repository rationalisation", "--tags", "github,repository", "--chat", "Claude session two"]);
    await assert.rejects(
      amb("reader", ["find", "github", "repository"]),
      (error) => error.code === 2 && /ambiguous top match/.test(error.stderr) && /repo-one/.test(error.stdout) && /repo-two/.test(error.stdout),
    );
    await assert.rejects(
      amb("reader", ["find", "wedding", "venue"]),
      (error) => error.code === 2 && /no AMB agent matches/.test(error.stderr),
    );
  });
});

test("AMB_AGENT overrides a stale terminal fallback identity", async () => {
  await withControlPlane(async ({ amb }) => {
    await amb("shared", ["add", "first", "--role", "First role"]);
    await amb("other", ["add", "second", "--role", "Second role"]);
    const output = await amb("shared", ["whoami"], { AMB_AGENT: "second" });
    assert.equal(output.stdout.trim(), "second");
  });
});
