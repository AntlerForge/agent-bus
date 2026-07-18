import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "./io.mjs";
import { buildBootstrapPrompt } from "./codex-bridge-prompts.mjs";

export const DEFAULT_CODEX_HOME = path.join(os.homedir(), ".codex");

function now() {
  return new Date().toISOString();
}

function quoteConfigValue(value) {
  return JSON.stringify(String(value));
}

function firstLine(text) {
  return text.split(/\r?\n/)[0].slice(0, 140);
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
  const args = [];
  if (options.profile) args.push("--profile", options.profile);
  args.push(
    "-a",
    "never",
    "exec",
  );
  if (options.ignoreUserConfig) args.push("--ignore-user-config");
  args.push(
    "--json",
    "--color",
    "never",
    "--sandbox",
    options.sandbox,
    "--output-last-message",
    outputFile,
    "-C",
    options.projectRoot,
  );

  if (sessionId) {
    args.push("resume", "-c", `model=${quoteConfigValue(options.model)}`, sessionId, "-");
  } else {
    args.push("-m", options.model, "-");
  }

  return args;
}

async function readIfPresent(filePath) {
  try { return await readFile(filePath, "utf8"); } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

async function recoverDetachedTurn({ outputFile, sessionFile, closedAt, options, log }) {
  const timeoutMs = Number(options.detachedRecoveryTimeoutMs || 10 * 60 * 1000);
  const quietMs = Number(options.detachedQuietMs || 90 * 1000);
  const deadline = Date.now() + timeoutMs;
  let lastAdvance = closedAt;
  let previousMtime = 0;
  while (Date.now() < deadline) {
    const reply = (await readIfPresent(outputFile)).trim();
    if (reply) return reply;
    if (sessionFile) {
      try {
        const current = (await stat(sessionFile)).mtimeMs;
        if (current > previousMtime) { previousMtime = current; lastAdvance = Date.now(); }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (Date.now() - lastAdvance > quietMs) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  log("Detached Codex worker did not produce a durable reply before becoming quiet.");
  return "";
}

async function runCodexProcess(prompt, options, sessionId = null, log = () => {}, runRef = null) {
  const tempDir = runRef ? null : await mkdtemp(path.join(os.tmpdir(), "agent-bus-codex-"));
  const resultDir = runRef ? path.join(path.dirname(options.sessionStore), "results", runRef) : tempDir;
  await mkdir(resultDir, { recursive: true });
  const outputFile = path.join(resultDir, "last-message.txt");
  const resultFile = path.join(resultDir, "turn-result.json");
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
      let outputFileBody = await readIfPresent(outputFile);
      if (code !== 0 && !lastAgentMessage && !outputFileBody.trim()) {
        log(`Codex wrapper exited ${code}; checking durable worker/session progress before declaring failure.`);
        outputFileBody = await recoverDetachedTurn({ outputFile, sessionFile: options.sessionFile, closedAt: Date.now(), options, log });
      }
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
      const reply = (lastAgentMessage || outputFileBody).trim();

      if (runRef && reply) {
        await writeJsonFileAtomic(resultFile, { run_ref: runRef, status: code === 0 ? "completed" : "recovered", exit_code: code, reply, completed_at: now() });
      }

      if (code !== 0 && !reply) {
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

async function createPersistentSession(options, log) {
  const beforeFiles = await listSessionFiles(options.codexHome);
  const startedAtMs = Date.now();
  const result = await runCodexProcess(buildBootstrapPrompt(options), options, null, log);
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

export async function getPersistentSession(options, log = () => {}) {
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
  return createPersistentSession(options, log);
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

export async function runPersistentTurn(prompt, options, session, log = () => {}, { messageId = null } = {}) {
  const runRef = messageId;
  const resultFile = runRef ? path.join(path.dirname(options.sessionStore), "results", runRef, "turn-result.json") : null;
  if (resultFile) {
    const recovered = await readJsonFile(resultFile, null);
    if (recovered?.reply && ["completed", "recovered"].includes(recovered.status)) {
      log(`Recovering durable completed turn for ${runRef}.`);
      return recovered.reply;
    }
  }
  const result = await runCodexProcess(prompt, { ...options, sessionFile: session.session_file }, session.session_id, log, runRef);
  await saveSessionTouch(options, session);
  return result.reply;
}
