#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { runCommand } from "./child-process.mjs";
import { getBusRoot } from "./paths.mjs";
import { readProviderSession, writeProviderSession } from "./provider-session-store.mjs";
import { runRuntimeBridge } from "./runtime-bridge.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function parseArgs(argv) {
  const stateDirectory = process.env.AGENT_BUS_CURSOR_STATE_DIR
    || path.join(os.homedir(), "Library", "Application Support", "Agent Bus", "cursor");
  const options = {
    agentId: process.env.AGENT_BUS_CURSOR_AGENT_ID || "cursor",
    command: process.env.AGENT_BUS_CURSOR_COMMAND || "cursor-agent",
    force: process.env.AGENT_BUS_CURSOR_FORCE !== "0",
    model: process.env.AGENT_BUS_CURSOR_MODEL || "cursor-grok-4.5-high",
    once: false,
    pollMs: Number.parseInt(process.env.AGENT_BUS_CURSOR_POLL_MS || "2000", 10),
    projectRoot: process.env.AGENT_BUS_CURSOR_WORKSPACE || process.env.AGENT_BUS_PROJECT_ROOT || PROJECT_ROOT,
    root: getBusRoot(),
    sandbox: process.env.AGENT_BUS_CURSOR_SANDBOX || "enabled",
    stateDirectory,
    timeoutMs: Number.parseInt(process.env.AGENT_BUS_CURSOR_TIMEOUT_MS || String(10 * 60 * 1000), 10),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--once") options.once = true;
    else if (arg === "--no-force") options.force = false;
    else if (arg === "--agent-id") options.agentId = argv[++index];
    else if (arg === "--command") options.command = argv[++index];
    else if (arg === "--model") options.model = argv[++index];
    else if (arg === "--poll-ms") options.pollMs = Number.parseInt(argv[++index], 10);
    else if (arg === "--root") options.root = argv[++index];
    else if (arg === "--sandbox") options.sandbox = argv[++index];
    else if (arg === "--state-directory") options.stateDirectory = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number.parseInt(argv[++index], 10);
    else if (arg === "--workspace") options.projectRoot = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: agent-bus-cursor-bridge [--once] [--model ID] [--workspace PATH] [--no-force]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  options.sessionStore = path.join(options.stateDirectory, "sessions.json");
  return options;
}

function createCursorRunner(options) {
  return async ({ prompt, message }) => {
    const stored = await readProviderSession(options.sessionStore, message.thread_id);
    const args = [];
    if (options.force) args.push("--force");
    args.push(
      "--sandbox", options.sandbox,
      "--output-format", "json",
      "--workspace", options.projectRoot,
      "--model", options.model,
    );
    if (stored?.session_id) args.push("--resume", stored.session_id);
    args.push("--print", prompt);
    const { stdout } = await runCommand(options.command, args, {
      cwd: options.projectRoot,
      timeoutMs: options.timeoutMs,
    });
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    const result = JSON.parse(line || "{}");
    if (result.is_error || result.subtype !== "success" || !result.result) {
      throw new Error(result.result || "Cursor returned no successful result");
    }
    if (result.session_id) {
      await writeProviderSession(options.sessionStore, message.thread_id, {
        session_id: result.session_id,
        provider: "cursor-cli",
        model: options.model,
        workspace: path.resolve(options.projectRoot),
      });
    }
    return { reply: result.result, session_id: result.session_id, usage: result.usage || null };
  };
}

const options = parseArgs(process.argv.slice(2));
await runRuntimeBridge({
  ...options,
  displayName: "Cursor Auto Bridge",
  type: "cursor-cli-bridge",
  provider: `Cursor CLI (${options.model})`,
  capabilities: ["coding", "debugging", "review", "local-tools", "persistent-thread-sessions"],
  runTurn: createCursorRunner(options),
});
