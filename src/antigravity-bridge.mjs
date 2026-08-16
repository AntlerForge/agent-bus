#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./child-process.mjs";
import { getBusRoot } from "./paths.mjs";
import { readProviderSession, writeProviderSession } from "./provider-session-store.mjs";
import { runRuntimeBridge } from "./runtime-bridge.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function parseArgs(argv) {
  const stateDirectory = process.env.AGENT_BUS_ANTIGRAVITY_STATE_DIR
    || path.join(os.homedir(), "Library", "Application Support", "Agent Bus", "antigravity");
  const options = {
    agentId: process.env.AGENT_BUS_ANTIGRAVITY_AGENT_ID || "antigravity",
    command: process.env.AGENT_BUS_ANTIGRAVITY_COMMAND || "agy",
    model: process.env.AGENT_BUS_ANTIGRAVITY_MODEL || "Gemini 3.5 Flash (Medium)",
    once: false,
    pollMs: Number.parseInt(process.env.AGENT_BUS_ANTIGRAVITY_POLL_MS || "2000", 10),
    projectRoot: process.env.AGENT_BUS_ANTIGRAVITY_WORKSPACE || process.env.AGENT_BUS_PROJECT_ROOT || PROJECT_ROOT,
    root: getBusRoot(),
    sandbox: process.env.AGENT_BUS_ANTIGRAVITY_SANDBOX !== "0",
    skipPermissions: process.env.AGENT_BUS_ANTIGRAVITY_SKIP_PERMISSIONS !== "0",
    stateDirectory,
    timeoutMs: Number.parseInt(process.env.AGENT_BUS_ANTIGRAVITY_TIMEOUT_MS || String(10 * 60 * 1000), 10),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--once") options.once = true;
    else if (arg === "--no-sandbox") options.sandbox = false;
    else if (arg === "--ask-permissions") options.skipPermissions = false;
    else if (arg === "--agent-id") options.agentId = argv[++index];
    else if (arg === "--command") options.command = argv[++index];
    else if (arg === "--model") options.model = argv[++index];
    else if (arg === "--poll-ms") options.pollMs = Number.parseInt(argv[++index], 10);
    else if (arg === "--root") options.root = argv[++index];
    else if (arg === "--state-directory") options.stateDirectory = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number.parseInt(argv[++index], 10);
    else if (arg === "--workspace") options.projectRoot = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: agent-bus-antigravity-bridge [--once] [--model NAME] [--workspace PATH]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  options.sessionStore = path.join(options.stateDirectory, "sessions.json");
  return options;
}

function conversationIdFromLog(logBody, fallback) {
  const match = logBody.match(/Print mode: conversation=([0-9a-f-]{36})/i)
    || logBody.match(/Created conversation ([0-9a-f-]{36})/i);
  return match?.[1] || fallback || null;
}

function createAntigravityRunner(options) {
  return async ({ prompt, message }) => {
    const stored = await readProviderSession(options.sessionStore, message.thread_id);
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "agent-bus-antigravity-"));
    const logFile = path.join(tempDirectory, "agy.log");
    const args = ["--mode", message.state_changes_allowed ? "accept-edits" : "plan"];
    if (options.sandbox) args.push("--sandbox");
    if (message.state_changes_allowed && options.skipPermissions) args.push("--dangerously-skip-permissions");
    args.push(
      "--model", options.model,
      "--print-timeout", `${Math.ceil(options.timeoutMs / 1000)}s`,
      "--log-file", logFile,
    );
    if (stored?.session_id) args.push("--conversation", stored.session_id);
    args.push("--print", prompt);

    try {
      const { stdout } = await runCommand(options.command, args, {
        cwd: options.projectRoot,
        timeoutMs: options.timeoutMs + 5000,
      });
      const logBody = await readFile(logFile, "utf8").catch(() => "");
      const sessionId = conversationIdFromLog(logBody, stored?.session_id);
      if (sessionId) {
        await writeProviderSession(options.sessionStore, message.thread_id, {
          session_id: sessionId,
          provider: "antigravity-cli",
          model: options.model,
          workspace: path.resolve(options.projectRoot),
        });
      }
      return { reply: stdout.trim(), session_id: sessionId };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  };
}

const options = parseArgs(process.argv.slice(2));
await runRuntimeBridge({
  ...options,
  displayName: "Antigravity Auto Bridge",
  type: "antigravity-cli-bridge",
  provider: `Antigravity CLI (${options.model})`,
  capabilities: ["coding", "analysis", "review", "local-tools", "persistent-thread-sessions"],
  runTurn: createAntigravityRunner(options),
});
