#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ackMessage, markRead, readInbox, replyMessage, updateThreadStatus } from "./mailbox.mjs";
import { ensureBusLayout, getBusRoot } from "./paths.mjs";

const PROJECT_ROOT = "/Users/antonybarfoot/Developer/personal/agent-bus";
const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_POLL_MS = 2000;

function parseArgs(argv) {
  const args = {
    once: false,
    model: process.env.AGENT_BUS_CODEX_MODEL || DEFAULT_MODEL,
    pollMs: Number.parseInt(process.env.AGENT_BUS_CODEX_POLL_MS || String(DEFAULT_POLL_MS), 10),
    codexCommand: process.env.AGENT_BUS_CODEX_COMMAND || "codex",
    projectRoot: process.env.AGENT_BUS_PROJECT_ROOT || PROJECT_ROOT,
    root: getBusRoot(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--once") {
      args.once = true;
    } else if (arg === "--model") {
      args.model = argv[++index];
    } else if (arg === "--poll-ms") {
      args.pollMs = Number.parseInt(argv[++index], 10);
    } else if (arg === "--codex-command") {
      args.codexCommand = argv[++index];
    } else if (arg === "--project-root") {
      args.projectRoot = argv[++index];
    } else if (arg === "--root") {
      args.root = argv[++index];
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
  --once                 Process current actionable Codex inbox messages, then exit.
  --model <model>        Codex CLI model to use. Default: ${DEFAULT_MODEL}
  --poll-ms <ms>         Watch interval in milliseconds. Default: ${DEFAULT_POLL_MS}
  --codex-command <cmd>  Codex command path. Default: codex
  --project-root <path>  Working repository for Codex CLI.
  --root <path>          Agent Bus root. Default: AGENT_BUS_ROOT or built-in root.
`);
}

function now() {
  return new Date().toISOString();
}

function log(message) {
  console.log(`[${now()}] ${message}`);
}

function buildPrompt(message) {
  return [
    "You are the Codex side of Agent Bus, running in the dedicated Codex terminal bridge.",
    "",
    "Handle the delegated task below. The bridge has already acknowledged the inbound message and will write your final answer back to Agent Bus, mark the inbound message read, and update thread status.",
    "",
    "Important rules:",
    "- Do not call Agent Bus MCP tools yourself.",
    "- Do not mark messages read or update thread status yourself.",
    "- Do the requested work using the local repository and available shell tools when needed.",
    "- Return only the reply body that should be sent back to the sender.",
    "- If blocked, explain the blocker clearly in the reply body.",
    "",
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Message ID: ${message.message_id}`,
    `Thread ID: ${message.thread_id}`,
    `Sequence: ${message.seq}`,
    "",
    "Message body:",
    message.body,
  ].join("\n");
}

async function runCodex(prompt, options) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-bus-codex-"));
  const promptFile = path.join(tempDir, "prompt.md");
  await writeFile(promptFile, prompt, "utf8");

  const childArgs = [
    "-a",
    "never",
    "exec",
    "-m",
    options.model,
    "--json",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
    "-C",
    options.projectRoot,
    "-",
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(options.codexCommand, childArgs, {
      cwd: options.projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let lastAgentMessage = "";
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
            log(`Codex: ${lastAgentMessage.split(/\r?\n/)[0].slice(0, 120)}`);
          } else if (message?.type === "exec_command_begin") {
            log(`Codex running command: ${message.command || "unknown"}`);
          } else if (message?.type === "task_started") {
            log("Codex task started.");
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
      await rm(tempDir, { recursive: true, force: true });
      if (code !== 0) {
        reject(new Error(`codex exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve(lastAgentMessage.trim());
    });

    readFile(promptFile, "utf8")
      .then((body) => {
        child.stdin.end(body);
      })
      .catch((error) => {
        child.kill();
        reject(error);
      });
  });
}

async function handleMessage(message, options) {
  log(`Handling ${message.message_id} from ${message.from}: ${message.subject}`);
  await ackMessage({ message_id: message.message_id }, options.root);

  try {
    const replyBody = await runCodex(buildPrompt(message), options);
    if (!replyBody) {
      throw new Error("Codex produced an empty reply.");
    }

    const reply = await replyMessage(
      {
        from: "codex",
        to: message.from,
        thread_id: message.thread_id,
        body: replyBody,
        requires_response: false,
      },
      options.root,
    );
    await markRead({ message_id: message.message_id }, options.root);
    await updateThreadStatus({ thread_id: message.thread_id, status: "completed" }, options.root);
    log(`Replied with ${reply.message_id}; completed ${message.thread_id}.`);
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

async function processInbox(options, active) {
  const messages = (await readInbox({ agent: "codex", include_read: false }, options.root)).filter(
    (message) => message.requires_response === true && !active.has(message.message_id),
  );

  for (const message of messages) {
    active.add(message.message_id);
    try {
      await handleMessage(message, options);
    } finally {
      active.delete(message.message_id);
    }
  }
}

const options = parseArgs(process.argv.slice(2));
const active = new Set();
await ensureBusLayout(options.root);
await mkdir(path.join(options.root, "inbox", "codex"), { recursive: true });

log(`Agent Bus Codex bridge watching ${path.join(options.root, "inbox", "codex")}`);
log(`Using Codex command "${options.codexCommand}" with model ${options.model}.`);

await processInbox(options, active);

if (!options.once) {
  setInterval(() => {
    processInbox(options, active).catch((error) => {
      log(`Poll failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, options.pollMs);
}
