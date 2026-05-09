import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { listThreads, readInbox, sendMessage } from "../src/mailbox.mjs";
import { ensureBusLayout } from "../src/paths.mjs";

async function withBusRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-bus-bridge-test-"));
  try {
    await ensureBusLayout(root);
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runBridge(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/codex-bridge.mjs", ...args], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`bridge exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

test("codex bridge processes an actionable inbox message with a fake Codex CLI", async () => {
  await withBusRoot(async (root) => {
    const fakeCodex = path.join(root, "fake-codex.mjs");
    const fakeRun = path.join(root, "fake-codex-run.json");
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "import { writeFileSync } from 'node:fs';",
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk.toString(); });",
        "process.stdin.on('end', () => {",
        `  writeFileSync(${JSON.stringify(fakeRun)}, JSON.stringify({ args: process.argv.slice(2), input }, null, 2));`,
        "  if (!input.includes('Bridge acceptance')) process.exit(2);",
        "  console.log(JSON.stringify({id:'0', msg:{type:'task_started'}}));",
        "  console.log(JSON.stringify({id:'0', msg:{type:'agent_message', message:'Bridge reply body'}}));",
        "});",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeCodex, 0o755);

    const sent = await sendMessage(
      {
        from: "claude-code",
        to: "codex",
        subject: "Bridge acceptance",
        body: "Please answer via bridge.",
        requires_response: true,
      },
      root,
    );

    await runBridge(["--once", "--root", root, "--codex-command", fakeCodex, "--session-id", "fake-session"]);

    const codexMessages = await readInbox({ agent: "codex", include_read: true }, root);
    const inbound = codexMessages.find((message) => message.message_id === sent.message_id);
    assert.equal(inbound.status, "read");

    const claudeMessages = await readInbox({ agent: "claude-code", include_read: false }, root);
    assert.equal(claudeMessages.length, 1);
    assert.equal(claudeMessages[0].body, "# Bridge acceptance\n\nBridge reply body");
    assert.equal(claudeMessages[0].requires_response, false);

    const threads = await listThreads(root);
    assert.equal(threads.find((thread) => thread.thread_id === sent.thread_id).status, "completed");

    const fakeRunData = JSON.parse(await readFile(fakeRun, "utf8"));
    assert.match(fakeRunData.input, /Agent Bus inbound message/);
    assert.match(fakeRunData.input, /Bridge acceptance/);
    assert.deepEqual(fakeRunData.args.slice(0, 2), ["-a", "never"]);
    assert.ok(fakeRunData.args.includes("resume"));
    assert.ok(fakeRunData.args.includes("fake-session"));
  });
});

test("codex bridge bootstraps and stores a persistent session id", async () => {
  await withBusRoot(async (root) => {
    const fakeCodexHome = path.join(root, "fake-codex-home");
    const fakeSessionFile = path.join(
      fakeCodexHome,
      "sessions",
      "2026",
      "04",
      "24",
      "rollout-2026-04-24T22-00-00-fake-created-session.jsonl",
    );
    const fakeCodex = path.join(root, "fake-codex-bootstrap.mjs");
    const sessionStore = path.join(root, "session-store.json");
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk.toString(); });",
        "process.stdin.on('end', () => {",
        "  if (!input.includes('persistent Codex responder')) process.exit(2);",
        `  const sessionFile = ${JSON.stringify(fakeSessionFile)};`,
        "  mkdirSync(dirname(sessionFile), { recursive: true });",
        "  const meta = { timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: 'fake-created-session', timestamp: new Date().toISOString(), cwd: process.cwd(), originator: 'fake-codex', cli_version: 'test' } };",
        "  writeFileSync(sessionFile, `${JSON.stringify(meta)}\\n`);",
        "  console.log(JSON.stringify({id:'0', msg:{type:'task_started'}}));",
        "  console.log(JSON.stringify({id:'0', msg:{type:'agent_message', message:'CODEX_BRIDGE_SESSION_READY'}}));",
        "});",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeCodex, 0o755);

    await runBridge([
      "--once",
      "--root",
      root,
      "--codex-command",
      fakeCodex,
      "--codex-home",
      fakeCodexHome,
      "--session-store",
      sessionStore,
      "--new-session",
    ]);

    const stored = JSON.parse(await readFile(sessionStore, "utf8"));
    assert.equal(stored.session_id, "fake-created-session");
    assert.equal(stored.session_file, fakeSessionFile);
  });
});
