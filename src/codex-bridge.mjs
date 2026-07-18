#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  ackMessage,
  getThread,
  markRead,
  readInbox,
  replyMessage,
  sendMessage,
  updateThreadStatus,
} from "./mailbox.mjs";
import { registerAgent } from "./agents.mjs";
import { ensureBusLayout, getBusRoot } from "./paths.mjs";
import {
  buildAgentBusPrompt,
  buildTerminalPrompt,
  parseResponseStatus,
} from "./codex-bridge-prompts.mjs";
import { DEFAULT_CODEX_HOME, getPersistentSession, runPersistentTurn } from "./codex-session.mjs";
import { createQueue } from "./task-queue.mjs";
import { configuredRemoteBus } from "./remote-bus.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");
const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_POLL_MS = 2000;
const DEFAULT_SANDBOX = "workspace-write";

function parseArgs(argv) {
  const root = getBusRoot();
  const defaultStateDirectory = process.env.AGENT_BUS_CONTROL_PLANE_URL
    ? path.join(os.homedir(), "Library", "Application Support", "Agent Bus", "codex")
    : root;
  const args = {
    once: false,
    noInput: false,
    newSession: false,
    model: process.env.AGENT_BUS_CODEX_MODEL || DEFAULT_MODEL,
    pollMs: Number.parseInt(process.env.AGENT_BUS_CODEX_POLL_MS || String(DEFAULT_POLL_MS), 10),
    codexCommand: process.env.AGENT_BUS_CODEX_COMMAND || "codex",
    codexHome: process.env.CODEX_HOME || DEFAULT_CODEX_HOME,
    ignoreUserConfig: process.env.AGENT_BUS_CODEX_IGNORE_USER_CONFIG !== "0",
    projectRoot: process.env.AGENT_BUS_PROJECT_ROOT || PROJECT_ROOT,
    profile: process.env.AGENT_BUS_CODEX_PROFILE || null,
    root,
    sandbox: process.env.AGENT_BUS_CODEX_SANDBOX || DEFAULT_SANDBOX,
    sessionId: process.env.AGENT_BUS_CODEX_SESSION_ID || null,
    sessionStore: process.env.AGENT_BUS_CODEX_SESSION_STORE || path.join(defaultStateDirectory, "sessions.json"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--once") {
      args.once = true;
    } else if (arg === "--no-input") {
      args.noInput = true;
    } else if (arg === "--new-session") {
      args.newSession = true;
    } else if (arg === "--model") {
      args.model = argv[++index];
    } else if (arg === "--poll-ms") {
      args.pollMs = Number.parseInt(argv[++index], 10);
    } else if (arg === "--codex-command") {
      args.codexCommand = argv[++index];
    } else if (arg === "--codex-home") {
      args.codexHome = argv[++index];
    } else if (arg === "--use-user-config") {
      args.ignoreUserConfig = false;
    } else if (arg === "--project-root") {
      args.projectRoot = argv[++index];
    } else if (arg === "--profile") {
      args.profile = argv[++index];
    } else if (arg === "--root") {
      args.root = argv[++index];
      if (!process.env.AGENT_BUS_CODEX_SESSION_STORE) {
        args.sessionStore = path.join(args.root, "_codex_bridge_session.json");
      }
    } else if (arg === "--sandbox") {
      args.sandbox = argv[++index];
    } else if (arg === "--session-id") {
      args.sessionId = argv[++index];
    } else if (arg === "--session-store") {
      args.sessionStore = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: agent-bus-codex-bridge [options]

Options:
  --once                  Process current actionable Codex inbox messages, then exit.
  --no-input              Do not open an interactive terminal prompt.
  --new-session           Create a fresh persistent Codex session instead of reusing the stored one.
  --model <model>         Codex CLI model to use. Default: ${DEFAULT_MODEL}
  --sandbox <mode>        Codex CLI sandbox. Default: ${DEFAULT_SANDBOX}
  --poll-ms <ms>          Watch interval in milliseconds. Default: ${DEFAULT_POLL_MS}
  --codex-command <cmd>   Codex command path. Default: codex
  --codex-home <path>     Codex home for session discovery. Default: ~/.codex
  --use-user-config       Load the normal Codex config and MCP integrations (off by default).
  --project-root <path>   Working repository for Codex CLI.
  --profile <name>        Codex config profile, useful for an isolated bridge runtime.
  --root <path>           Agent Bus root. Default: AGENT_BUS_ROOT or built-in root.
  --session-id <uuid>     Resume this Codex session instead of reading the session store.
  --session-store <path>  JSON file used to remember the bridge session.
`);
}

function now() {
  return new Date().toISOString();
}

function log(message) {
  console.log(`[${now()}] ${message}`);
}

async function registerHeartbeat(options) {
  const args = {
    agent_id: "codex",
    display_name: "Codex Auto Bridge",
    type: "codex-cli-bridge",
    capabilities: ["coding", "debugging", "review", "local-tools", "agent-bus-auto-response", "persistent-session"],
  };
  const remote = configuredRemoteBus();
  return remote ? remote.registerAgent(args) : registerAgent(args, options.root);
}

async function handleMessage(message, options, session) {
  log(`Handling ${message.message_id} from ${message.from}: ${message.subject}`);
  await ackMessage({ message_id: message.message_id }, options.root);

  try {
    const remote = configuredRemoteBus();
    const [thread, artifacts] = await Promise.all([
      getThread({ thread_id: message.thread_id }, options.root),
      remote
        ? remote.materializeMessageArtifacts(message, path.join(path.dirname(options.sessionStore), "artifacts", message.thread_id))
        : Promise.resolve((message.artifact_paths || []).map((artifactPath) => ({ local_path: artifactPath, filename: path.basename(artifactPath) }))),
    ]);
    const rawReply = await runPersistentTurn(buildAgentBusPrompt(message, thread.body, options, artifacts), options, session, log);
    if (!rawReply) {
      throw new Error("Codex produced an empty reply.");
    }

    const { status, body } = parseResponseStatus(rawReply);
    const reply = await replyMessage(
      {
        from: "codex",
        to: message.from,
        thread_id: message.thread_id,
        body,
        requires_response: false,
      },
      options.root,
    );
    await markRead({ message_id: message.message_id }, options.root);
    await updateThreadStatus({ thread_id: message.thread_id, status }, options.root);
    log(`Replied with ${reply.message_id}; set ${message.thread_id} to ${status}.`);
  } catch (error) {
    const body = [
      "Codex bridge failed while processing this Agent Bus message.",
      "",
      error instanceof Error ? error.message : String(error),
    ].join("\n");
    await replyMessage(
      {
        from: "codex",
        to: message.from,
        thread_id: message.thread_id,
        body,
        requires_response: false,
      },
      options.root,
    );
    await markRead({ message_id: message.message_id }, options.root);
    await updateThreadStatus({ thread_id: message.thread_id, status: "failed" }, options.root);
    log(`Failed ${message.message_id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function processInbox(options, session, queue, active) {
  const messages = (await readInbox({ agent: "codex", include_read: false }, options.root)).filter(
    (message) => message.requires_response === true && !active.has(message.message_id),
  );

  for (const message of messages) {
    active.add(message.message_id);
    queue.enqueue(async () => {
      try {
        await handleMessage(message, options, session);
      } finally {
        active.delete(message.message_id);
      }
    });
  }
}

function printTerminalHelp(session, options) {
  console.log([
    "Commands:",
    "  /help      Show this help.",
    "  /session   Show the persistent Codex session id.",
    "  /send      Send: /send claude-code | Subject | Body",
    "  /quit      Close the bridge.",
    "",
    "Any other text is sent to the same persistent Codex session used for Claude messages.",
    `Session: ${session.session_id}`,
    `Model: ${options.model}`,
  ].join("\n"));
}

async function sendTerminalMessage(line, options) {
  const parts = line.slice("/send ".length).split("|").map((part) => part.trim());
  const [to, subject, ...bodyParts] = parts;
  const body = bodyParts.join(" | ").trim();
  if (!to || !subject || !body) {
    console.log("Usage: /send claude-code | Subject | Body");
    return;
  }

  const sent = await sendMessage(
    {
      from: "codex",
      to,
      subject,
      body,
      ack_required: true,
      requires_response: true,
    },
    options.root,
  );
  console.log(`Sent ${sent.message_id} on ${sent.thread_id} to ${to}.`);
}

function startTerminalInput(options, session, queue) {
  if (options.once || options.noInput || !process.stdin.isTTY) {
    return null;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "agent-bus> ",
  });

  queue.setPromptRefresh(() => {
    if (queue.isIdle()) {
      rl.prompt();
    }
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }
    if (trimmed === "/quit" || trimmed === "/exit") {
      rl.close();
      return;
    }
    if (trimmed === "/help") {
      printTerminalHelp(session, options);
      rl.prompt();
      return;
    }
    if (trimmed === "/session") {
      console.log(`Session: ${session.session_id}`);
      console.log(`Session store: ${options.sessionStore}`);
      console.log(`Model: ${options.model}`);
      console.log(`Sandbox: ${options.sandbox}`);
      rl.prompt();
      return;
    }
    if (trimmed.startsWith("/send ")) {
      sendTerminalMessage(trimmed, options)
        .catch((error) => {
          log(`Send failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => rl.prompt());
      return;
    }

    queue.enqueue(async () => {
      const reply = await runPersistentTurn(buildTerminalPrompt(line, options), options, session, log);
      console.log(`\n${reply}\n`);
    });
  });

  rl.on("close", () => {
    log("Codex bridge terminal closed.");
    process.exit(0);
  });

  printTerminalHelp(session, options);
  rl.prompt();
  return rl;
}

const options = parseArgs(process.argv.slice(2));
const active = new Set();
const queue = createQueue({ log });
await mkdir(path.dirname(options.sessionStore), { recursive: true });
if (!configuredRemoteBus()) {
  await ensureBusLayout(options.root);
  await mkdir(path.join(options.root, "inbox", "codex"), { recursive: true });
}
await registerHeartbeat(options);

const session = await getPersistentSession(options, log);
const remoteBus = configuredRemoteBus();
log(`Agent Bus Codex bridge watching ${remoteBus ? `${process.env.AGENT_BUS_CONTROL_PLANE_URL}/api/v1/inbox/codex` : path.join(options.root, "inbox", "codex")}`);
log(`Using Codex command "${options.codexCommand}" with model ${options.model}.`);
log(`Persistent session: ${session.session_id}`);
log(`Session store: ${options.sessionStore}`);

startTerminalInput(options, session, queue);
await processInbox(options, session, queue, active);

if (options.once) {
  await queue.waitForIdle();
} else {
  setInterval(() => {
    processInbox(options, session, queue, active).catch((error) => {
      log(`Poll failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, options.pollMs);
  setInterval(() => {
    registerHeartbeat(options).catch((error) => {
      log(`Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 30000);
}
