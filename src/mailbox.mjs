import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { registerArtifacts } from "./artifacts.mjs";
import { touchAgent } from "./agents.mjs";
import { makeId, nowIso } from "./ids.mjs";
import { readJsonFile, writeFileAtomic, writeJsonFileAtomic } from "./io.mjs";
import {
  appendThreadEntry,
  messageBody,
  parseMarkdownWithFrontmatter,
  stringifyMarkdownWithFrontmatter,
} from "./markdown.mjs";
import { ensureBusLayout } from "./paths.mjs";
import { assertNoObviousSecrets } from "./security.mjs";
import { configuredRemoteBus } from "./remote-bus.mjs";

const ALLOWED_STATUSES = new Set([
  "open",
  "acknowledged",
  "in_progress",
  "input_required",
  "blocked",
  "completed",
  "failed",
  "canceled",
  "closed",
]);

function inboxPath(paths, agent, messageId) {
  return path.join(paths.inbox, agent, `${messageId}.md`);
}

function threadPath(paths, threadId) {
  return path.join(paths.threads, `${threadId}.md`);
}

async function readThread(paths, threadId) {
  const filePath = threadPath(paths, threadId);
  const raw = await readFile(filePath, "utf8");
  return { filePath, ...parseMarkdownWithFrontmatter(raw) };
}

async function writeThread(filePath, data, body) {
  await writeFileAtomic(filePath, stringifyMarkdownWithFrontmatter(data, body));
}

async function readIdempotency(paths) {
  return readJsonFile(paths.idempotencyFile, {});
}

async function recordIdempotency(paths, key, result) {
  if (!key) {
    return;
  }
  const state = await readIdempotency(paths);
  state[key] = result;
  await writeJsonFileAtomic(paths.idempotencyFile, state);
}

export async function sendMessage(
  {
    from,
    to,
    subject,
    body,
    thread_id,
    priority = "normal",
    ack_required = false,
    requires_response = false,
    artifact_paths = [],
    idempotency_key,
  },
  root,
) {
  const remote = configuredRemoteBus();
  if (remote) return remote.sendMessage({
    from, to, subject, body, thread_id, priority, ack_required, requires_response, artifact_paths, idempotency_key,
  });
  if (!from || !to || !subject || !body) {
    throw new Error("from, to, subject, and body are required");
  }
  assertNoObviousSecrets(subject, body);

  const paths = await ensureBusLayout(root);
  await touchAgent(from, root);

  if (idempotency_key) {
    const state = await readIdempotency(paths);
    if (state[idempotency_key]) {
      return { ...state[idempotency_key], deduplicated: true };
    }
  }

  const created = nowIso();
  const messageId = makeId("msg");
  const threadId = thread_id || makeId("thread");
  await mkdir(path.join(paths.inbox, to), { recursive: true });
  const messageFile = inboxPath(paths, to, messageId);
  const threadFile = threadPath(paths, threadId);

  let threadData;
  let threadBody;
  let seq;

  if (thread_id) {
    const thread = await readThread(paths, threadId);
    threadData = thread.data;
    threadBody = thread.body;
    seq = Number(threadData.next_seq || 1);
  } else {
    threadData = {
      id: threadId,
      status: "open",
      subject,
      participants: Array.from(new Set([from, to])),
      created,
      updated: created,
      next_seq: 1,
    };
    threadBody = `# ${subject}\n`;
    seq = 1;
  }

  threadData.participants = Array.from(new Set([...(threadData.participants || []), from, to]));
  threadData.updated = created;
  threadData.next_seq = seq + 1;

  const messageData = {
    id: messageId,
    seq,
    thread: threadId,
    from,
    to,
    status: "unread",
    created,
    subject,
    priority,
    ack_required: Boolean(ack_required),
    requires_response: Boolean(requires_response),
    artifact_paths,
    idempotency_key: idempotency_key || null,
  };

  const registeredArtifacts = await registerArtifacts(
    { artifact_paths, producer: from, message_id: messageId, thread_id: threadId },
    root,
  );
  if (registeredArtifacts.length) {
    messageData.artifacts = registeredArtifacts.map((artifact) => artifact.artifact_id);
  }

  await writeFileAtomic(messageFile, stringifyMarkdownWithFrontmatter(messageData, messageBody(subject, body)));

  const updatedThreadBody = appendThreadEntry(threadBody, {
    seq,
    id: messageId,
    created,
    from,
    to,
    body,
  });
  await writeThread(threadFile, threadData, updatedThreadBody);

  const result = {
    message_id: messageId,
    thread_id: threadId,
    seq,
    inbox_file: messageFile,
    thread_file: threadFile,
    artifacts: registeredArtifacts,
  };
  await recordIdempotency(paths, idempotency_key, result);
  return result;
}

export async function replyMessage(
  { from, to, thread_id, body, priority = "normal", ack_required = false, requires_response = false, artifact_paths = [] },
  root,
) {
  const remote = configuredRemoteBus();
  if (remote) return remote.replyMessage({ from, to, thread_id, body, priority, ack_required, requires_response, artifact_paths });
  const paths = await ensureBusLayout(root);
  const thread = await readThread(paths, thread_id);
  const subject = thread.data.subject || `Reply to ${thread_id}`;
  return sendMessage({ from, to, subject, body, thread_id, priority, ack_required, requires_response, artifact_paths }, root);
}

async function readInboxFile(filePath) {
  const raw = await readFile(filePath, "utf8");
  const parsed = parseMarkdownWithFrontmatter(raw);
  return { filePath, data: parsed.data, body: parsed.body };
}

export async function readInbox({ agent, include_read = false }, root) {
  const remote = configuredRemoteBus();
  if (remote) return remote.readInbox({ agent, include_read });
  if (!agent) {
    throw new Error("agent is required");
  }
  const paths = await ensureBusLayout(root);
  await touchAgent(agent, root);
  const dir = path.join(paths.inbox, agent);
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir, { withFileTypes: true });
  const messages = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const message = await readInboxFile(path.join(dir, entry.name));
    if (!include_read && message.data.status === "read") {
      continue;
    }
    messages.push({
      message_id: message.data.id,
      thread_id: message.data.thread,
      seq: message.data.seq,
      from: message.data.from,
      to: message.data.to,
      status: message.data.status,
      subject: message.data.subject,
      created: message.data.created,
      priority: message.data.priority,
      ack_required: message.data.ack_required,
      requires_response: message.data.requires_response,
      acknowledged: message.data.acknowledged || null,
      read: message.data.read || null,
      artifact_paths: message.data.artifact_paths || [],
      artifacts: message.data.artifacts || [],
      file: message.filePath,
      body: message.body.trim(),
    });
  }

  messages.sort((a, b) => String(a.created).localeCompare(String(b.created)) || Number(a.seq) - Number(b.seq));
  return messages;
}

async function findMessageFile(messageId, root) {
  const paths = await ensureBusLayout(root);
  const agents = await readdir(paths.inbox, { withFileTypes: true });
  for (const agentDir of agents) {
    if (!agentDir.isDirectory()) {
      continue;
    }
    const filePath = path.join(paths.inbox, agentDir.name, `${messageId}.md`);
    try {
      return await readInboxFile(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  throw new Error(`Message not found: ${messageId}`);
}

export async function ackMessage({ message_id }, root) {
  const remote = configuredRemoteBus();
  if (remote) return remote.ackMessage({ message_id });
  const message = await findMessageFile(message_id, root);
  const acknowledged = nowIso();
  message.data.status = message.data.status === "read" ? "read" : "acknowledged";
  message.data.acknowledged = acknowledged;
  await writeFileAtomic(message.filePath, stringifyMarkdownWithFrontmatter(message.data, message.body));

  const paths = await ensureBusLayout(root);
  const thread = await readThread(paths, message.data.thread);
  if (thread.data.status === "open") {
    thread.data.status = "acknowledged";
    thread.data.updated = acknowledged;
    await writeThread(
      thread.filePath,
      thread.data,
      `${thread.body.trimEnd()}\n\n_Status changed to acknowledged at ${acknowledged}._\n`,
    );
  }

  return { message_id, status: message.data.status, acknowledged, file: message.filePath };
}

export async function markRead({ message_id }, root) {
  const remote = configuredRemoteBus();
  if (remote) return remote.markRead({ message_id });
  const message = await findMessageFile(message_id, root);
  const read = nowIso();
  message.data.status = "read";
  message.data.read = read;
  await writeFileAtomic(message.filePath, stringifyMarkdownWithFrontmatter(message.data, message.body));
  return { message_id, status: "read", read, file: message.filePath };
}

export async function updateThreadStatus({ thread_id, status, reason = null, actor = null }, root) {
  const remote = configuredRemoteBus();
  if (remote) return remote.updateThreadStatus({ thread_id, status, reason, actor });
  if (!ALLOWED_STATUSES.has(status)) {
    throw new Error(`Unsupported thread status: ${status}`);
  }
  const paths = await ensureBusLayout(root);
  const thread = await readThread(paths, thread_id);
  const updated = nowIso();
  thread.data.status = status;
  thread.data.updated = updated;
  const audit = reason ? ` Reason: ${String(reason).trim()}${actor ? ` (actor: ${String(actor).trim()})` : ""}.` : "";
  const body = `${thread.body.trimEnd()}\n\n_Status changed to ${status} at ${updated}._${audit}\n`;
  await writeThread(thread.filePath, thread.data, body);
  return { thread_id, status, updated, reason: reason || null, actor: actor || null, file: thread.filePath };
}

export async function listThreads(root) {
  const remote = configuredRemoteBus();
  if (remote) return remote.listThreads();
  const paths = await ensureBusLayout(root);
  const entries = await readdir(paths.threads, { withFileTypes: true });
  const threads = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const filePath = path.join(paths.threads, entry.name);
    const raw = await readFile(filePath, "utf8");
    const { data } = parseMarkdownWithFrontmatter(raw);
    threads.push({
      thread_id: data.id,
      subject: data.subject,
      status: data.status,
      participants: data.participants || [],
      created: data.created,
      updated: data.updated,
      next_seq: data.next_seq,
      file: filePath,
    });
  }
  threads.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  return threads;
}

export async function getThread({ thread_id }, root) {
  const remote = configuredRemoteBus();
  if (remote) return remote.getThread({ thread_id });
  if (!thread_id) {
    throw new Error("thread_id is required");
  }
  const paths = await ensureBusLayout(root);
  const thread = await readThread(paths, thread_id);
  return {
    thread_id: thread.data.id,
    subject: thread.data.subject,
    status: thread.data.status,
    participants: thread.data.participants || [],
    created: thread.data.created,
    updated: thread.data.updated,
    next_seq: thread.data.next_seq,
    body: thread.body.trim(),
  };
}
