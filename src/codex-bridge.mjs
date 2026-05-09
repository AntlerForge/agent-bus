#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  ackMessage,
  markRead,
  readInbox,
  replyMessage,
  sendMessage,
  updateThreadStatus,
} from "./mailbox.mjs";
import { readJsonFile, writeJsonFileAtomic } from "./io.mjs";
import { ensureBusLayout, getBusRoot } from "./paths.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");
const DEFAULT_MODEL = "gpt-5.2";
const DEFAULT_POLL_MS = 2000;
const DEFAULT_SANDBOX = "workspace-write";
const DEFAULT_CODEX_HOME = path.join(os.homedir(), ".codex");
const ALLOWED_RESPONSE_STATUSES = new Set(["completed", "input_required", "blocked", "failed"]);

function parseArgs(argv) {
  const root = getBusRoot();
  const args = {
    once: false,
    noInput: false,
    newSession: false,
    model: process.env.AGENT_BUS_CODEX_MODEL || DEFAULT_MODEL,
    pollMs: Number.parseInt(process.env.AGENT_BUS_CODEX_POLL_MS || String(DEFAULT_POLL_MS), 10),
    codexCommand: process.env.AGENT_BUS_CODEX_COMMAND || "codex",
    codexHome: process.env.CODEX_HOME || DEFAULT_CODEX_HOME,
    projectRoot: process.env.AGENT_BUS_PROJECT_ROOT || PROJECT_ROOT,
    root,
    sandbox: process.env.AGENT_BUS_CODEX_SANDBOX || DEFAULT_SANDBOX,
    sessionId: process.env.AGENT_BUS_CODEX_SESSION_ID || null,
    sessionStore: process.env.AGENT_BUS_CODEX_SESSION_STORE || path.join(root, "_codex_bridge_session.json"),
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
    } else if (arg === "--project-root") {
      args.projectRoot = argv[++index];
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
  --project-root <path>   Working repository for Codex CLI.
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

function quoteConfigValue(value) {
  return JSON.stringify(String(value));
}

function firstLine(text) {
  return text.split(/\r?\n/)[0].slice(0, 140);
}

async function readThreadMarkdown(root, threadId) {
  if (!threadId) {
    return "";
  }

  try {
    return await readFile(path.join(root, "threads", `${threadId}.md`), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function buildBootstrapPrompt(options) {
  return [
    "You are the persistent Codex responder for Agent Bus.",
    "",
    "This is a dedicated Codex CLI session. The bridge will resume this exact session for later",
    "messages from Claude or Claude Code and for terminal input from the user. Treat earlier turns in",
    "this session as durable working context.",
    "",
    "Operating rules:",
    "- Maintain context across Agent Bus and terminal turns.",
    "- The bridge handles Agent Bus ack, reply, read-state, and thread-status writes.",
    "- Do not call Agent Bus tools yourself for inbound Agent Bus messages.",
    "- Use local tools only when needed for the actual task.",
    "- Keep replies direct and suitable for forwarding when the bridge gives you an Agent Bus task.",
    "",
    `Agent Bus root: ${options.root}`,
    `Shared artifact directory: ${path.join(options.root, "shared")}`,
    `Project root: ${options.projectRoot}`,
    "",
    "Reply exactly: CODEX_BRIDGE_SESSION_READY",
  ].join("\n");
}

function buildAgentBusPrompt(message, threadMarkdown, options) {
  return [
    "Agent Bus inbound message delivered into your persistent Codex bridge session.",
    "",
    "The bridge has already acknowledged the inbound message. Do the requested work using the",
    "persistent session context, the thread transcript below, and any referenced local files.",
    "",
    "Bridge responsibilities:",
    "- The bridge will write your final answer back to Agent Bus.",
    "- The bridge will mark the inbound message read.",
    "- The bridge will update the thread status.",
    "",
    "Response format:",
    "- Return only the reply body that should be sent to the sender.",
    "- Optional first line: STATUS: completed | input_required | blocked | failed",
    "- If the optional STATUS line is omitted, the bridge will mark the thread completed.",
    "- Do not ask the user what to do unless the task is genuinely blocked or needs their judgment.",
    "",
    `Agent Bus root: ${options.root}`,
    `Shared artifact directory: ${path.join(options.root, "shared")}`,
    "",
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Message ID: ${message.message_id}`,
    `Thread ID: ${message.thread_id}`,
    `Sequence: ${message.seq}`,
    "",
    "Current thread transcript:",
    threadMarkdown || "(thread transcript unavailable)",
    "",
    "Inbound message body:",
    message.body,
  ].join("\n");
}

function buildTerminalPrompt(input, options) {
  return [
    "Terminal input from the user into the persistent Codex Agent Bus bridge session.",
    "",
    "Reply to the user in this terminal. Use the persistent context from prior terminal and Agent Bus",
    "turns. If the user asks you to prepare a message for Claude, draft it clearly; the bridge terminal",
    "does not automatically send terminal replies to Agent Bus unless a bridge command says so.",
    "",
    `Agent Bus root: ${options.root}`,
    `Shared artifact directory: ${path.join(options.root, "shared")}`,
    "",
    "User input:",
    input,
  ].join("\n");
}

function parseResponseStatus(replyBody) {
  const match = replyBody.match(/^STATUS:\s*(completed|input_required|blocked|failed)\s*(?:\r?\n|$)/i);
  if (!match) {
    return { status: "completed", body: replyBody.trim() };
  }

  const status = match[1].toLowerCase();
  const body = replyBody.slice(match[0].length).trim();
  return {
    status: ALLOWED_RESPONSE_STATUSES.has(status) ? status : "completed",
    body: body || replyBody.trim(),
  };
}

async function listSessionFiles(codexHome) {
  const sessionsRoot = path.join(codexHome, "sessions");
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  }

  await walk(sessionsRoot);
  return files;
}

async function readSessionMeta(filePath) {
  const raw = await readFile(filePath, "utf8");
  const first = raw.split(/\r?\n/, 1)[0];
  if (!first) {
    return null;
  }
  const event = JSON.parse(first);
  if (event.type !== "session_meta") {
    return null;
  }
  return event.payload || null;
}

async function findCreatedSession(beforeFiles, options, startedAtMs) {
  const before = new Set(beforeFiles);
  const files = await listSessionFiles(options.codexHome);
  const candidates = [];

  for (const filePath of files) {
    if (before.has(filePath)) {
      continue;
    }

    const fileStat = await stat(filePath);
    if (fileStat.mtimeMs < startedAtMs - 2000) {
      continue;
    }

    const meta = await readSessionMeta(filePath);
    if (!meta || path.resolve(meta.cwd || "") !== path.resolve(options.projectRoot)) {
      continue;
    }

    candidates.push({ filePath, meta, mtimeMs: fileStat.mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] || null;
}

function buildCodexArgs(options, outputFile, sessionId) {
  const args = [
    "-a",
    "never",
    "exec",
    "--json",
    "--color",
    "never",
    "--sandbox",
    options.sandbox,
    "--output-last-message",
    outputFile,
    "-C",
    options.projectRoot,
  ];

  if (sessionId) {
    args.push("resume", "-c", `model=${quoteConfigValue(options.model)}`, sessionId, "-");
  } else {
    args.push("-m", options.model, "-");
  }

  return args;
}

async function runCodexProcess(prompt, options, sessionId = null) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-bus-codex-"));
  const outputFile = path.join(tempDir, "last-message.txt");
  const childArgs = buildCodexArgs(options, outputFile, sessionId);

  return new Promise((resolve, reject) => {
    const child = spawn(options.codexCommand, childArgs, {
      cwd: options.projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let lastAgentMessage = "";
    let lastError = "";
    let lineBuffer = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        try {
          const event = JSON.parse(line);
          const message = event.msg;
          if (message?.type === "agent_message") {
            lastAgentMessage = message.message || "";
            log(`Codex: ${firstLine(lastAgentMessage)}`);
          } else if (message?.type === "exec_command_begin") {
            log(`Codex running command: ${message.command || "unknown"}`);
          } else if (message?.type === "task_started") {
            log("Codex task started.");
          } else if (message?.type === "error") {
            lastError = message.message || "Unknown Codex error";
          }
        } catch {
          log(line);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", async (code) => {
      let outputFileBody = "";
      try {
        outputFileBody = await readFile(outputFile, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") {
          await rm(tempDir, { recursive: true, force: true });
          reject(error);
          return;
        }
      }

      await rm(tempDir, { recursive: true, force: true });
      const reply = (lastAgentMessage || outputFileBody).trim();

      if (code !== 0) {
        reject(new Error(`codex exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      if (!reply && lastError) {
        reject(new Error(lastError));
        return;
      }

      resolve({ reply, stdout, stderr });
    });

    child.stdin.end(prompt);
  });
}

async function createPersistentSession(options) {
  const beforeFiles = await listSessionFiles(options.codexHome);
  const startedAtMs = Date.now();
  const result = await runCodexProcess(buildBootstrapPrompt(options), options);
  if (result.reply !== "CODEX_BRIDGE_SESSION_READY") {
    log(`Bootstrap reply: ${result.reply || "(empty)"}`);
  }

  const created = await findCreatedSession(beforeFiles, options, startedAtMs);
  if (!created?.meta?.id) {
    throw new Error(`Could not locate new Codex session file under ${path.join(options.codexHome, "sessions")}`);
  }

  const session = {
    session_id: created.meta.id,
    session_file: created.filePath,
    model: options.model,
    sandbox: options.sandbox,
    project_root: path.resolve(options.projectRoot),
    codex_home: path.resolve(options.codexHome),
    created_at: created.meta.timestamp || now(),
    updated_at: now(),
  };
  await writeJsonFileAtomic(options.sessionStore, session);
  return session;
}

async function canReuseStoredSession(stored, options) {
  if (!stored?.session_id) {
    return false;
  }
  if (stored.project_root && path.resolve(stored.project_root) !== path.resolve(options.projectRoot)) {
    return false;
  }
  if (stored.codex_home && path.resolve(stored.codex_home) !== path.resolve(options.codexHome)) {
    return false;
  }
  if (!stored.session_file) {
    return true;
  }

  try {
    await stat(stored.session_file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function getPersistentSession(options) {
  if (options.sessionId) {
    return {
      session_id: options.sessionId,
      model: options.model,
      sandbox: options.sandbox,
      project_root: path.resolve(options.projectRoot),
      codex_home: path.resolve(options.codexHome),
      created_at: null,
      updated_at: now(),
      source: "argument",
    };
  }

  if (!options.newSession) {
    const stored = await readJsonFile(options.sessionStore, null);
    if (await canReuseStoredSession(stored, options)) {
      return stored;
    }
    if (stored?.session_id) {
      log("Stored Codex bridge session is not reusable; creating a new one.");
    }
  }

  log("Creating persistent Codex bridge session.");
  return createPersistentSession(options);
}

async function saveSessionTouch(options, session) {
  if (session.source === "argument") {
    return;
  }

  Object.assign(session, {
    ...session,
    model: options.model,
    sandbox: options.sandbox,
    updated_at: now(),
  });
  await writeJsonFileAtomic(options.sessionStore, session);
}

async function runPersistentTurn(prompt, options, session) {
  const result = await runCodexProcess(prompt, options, session.session_id);
  await saveSessionTouch(options, session);
  return result.reply;
}

async function handleMessage(message, options, session) {
  log(`Handling ${message.message_id} from ${message.from}: ${message.subject}`);
  await ackMessage({ message_id: message.message_id }, options.root);

  try {
    const threadMarkdown = await readThreadMarkdown(options.root, message.thread_id);
    const rawReply = await runPersistentTurn(buildAgentBusPrompt(message, threadMarkdown, options), options, session);
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

function createQueue() {
  const queue = [];
  const waiters = [];
  let draining = false;
  let promptRefresh = () => {};

  async function drain() {
    if (draining) {
      return;
    }

    draining = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        try {
          await item.run();
        } catch (error) {
          log(`Queued task failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      draining = false;
      while (waiters.length) {
        waiters.shift()();
      }
      promptRefresh();
    }
  }

  return {
    enqueue(run) {
      queue.push({ run });
      void drain();
    },
    waitForIdle() {
      if (!draining && queue.length === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    setPromptRefresh(refresh) {
      promptRefresh = refresh;
    },
    isIdle() {
      return !draining && queue.length === 0;
    },
  };
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
      const reply = await runPersistentTurn(buildTerminalPrompt(line, options), options, session);
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
const queue = createQueue();
await ensureBusLayout(options.root);
await mkdir(path.join(options.root, "inbox", "codex"), { recursive: true });
await mkdir(path.dirname(options.sessionStore), { recursive: true });

const session = await getPersistentSession(options);
log(`Agent Bus Codex bridge watching ${path.join(options.root, "inbox", "codex")}`);
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
}
