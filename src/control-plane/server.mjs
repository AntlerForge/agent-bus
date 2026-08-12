#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFile, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyLiveness, heartbeatAgent, listAgents, registerAgent, setAgentLifecycleStatus, LIVENESS_THRESHOLDS } from "../agents.mjs";
import { readArtifactContent, readArtifactManifest, uploadSharedArtifact } from "../artifacts.mjs";
import { getThread, listThreads } from "../mailbox.mjs";
import { ackMessage, markRead, readInbox, replyMessage, sendMessage, updateThreadStatus } from "../mailbox.mjs";
import { ensureBusLayout, getBusRoot } from "../paths.mjs";
import { buildWorkflowProposals, loadModelSelector } from "../model-selector.mjs";
import {
  assignWorkItem,
  createWorkItem,
  getUsageSummary,
  getWorkItem,
  getWorkItemReceipt,
  listWorkItemEvents,
  listWorkItems,
  reviewWorkItem,
  startRun,
  submitReceipt,
  transitionWorkItem,
  updateRun,
} from "../work-ledger/store.mjs";

const VERSION = "0.5.0";
const STARTED_AT = new Date().toISOString();
const STATIC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function normalizeBasePath(value) {
  const normalized = String(value || "").trim().replace(/^\/*/, "/").replace(/\/+$/, "");
  return normalized === "/" ? "" : normalized;
}

async function createFileLogger(logDirectory) {
  if (!logDirectory) return () => {};
  const directory = path.resolve(logDirectory);
  await mkdir(directory, { recursive: true });
  const retentionCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const filename of await readdir(directory)) {
    const match = filename.match(/^control-plane-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (match && new Date(`${match[1]}T00:00:00Z`).getTime() < retentionCutoff) {
      await unlink(path.join(directory, filename));
    }
  }
  return (record) => {
    const timestamp = new Date().toISOString();
    const entry = { timestamp, service: "agent-bus-control-plane", level: "INFO", ...record };
    const file = path.join(directory, `control-plane-${timestamp.slice(0, 10)}.jsonl`);
    void appendFile(file, `${JSON.stringify(entry)}\n`, "utf8").catch(() => {});
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request body exceeds 1 MiB");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function requireWriteAccess(request, writeToken) {
  if (!writeToken) return;
  if (request.headers.authorization !== `Bearer ${writeToken}`) {
    const error = new Error("A valid bearer token is required for write operations");
    error.statusCode = 401;
    throw error;
  }
}

function routeMatch(pathname, suffix) {
  const match = pathname.match(new RegExp(`^/api/v1/work-items/([^/]+)/${suffix}$`));
  return match ? decodeURIComponent(match[1]) : null;
}

function deriveAgents(agents, items) {
  return agents.map((agent) => {
    const current = items.find(
      (item) => item.current_assignment?.agent_id === agent.agent_id && !["done", "canceled"].includes(item.status),
    );
    return {
      ...agent,
      derived_status: current ? (current.status === "blocked" ? "blocked" : "working") : "available",
      current_work_item: current
        ? { work_item_id: current.work_item_id, title: current.title, status: current.status }
        : null,
      queued_count: items.filter(
        (item) => item.current_assignment?.agent_id === agent.agent_id && item.status === "ready",
      ).length,
    };
  });
}

async function agentsStatus(root) {
  const [agents, items] = await Promise.all([listAgents(root), listWorkItems({}, root)]);
  const nowMs = Date.now();
  return {
    schema_version: 1,
    generated_at: new Date(nowMs).toISOString(),
    thresholds: LIVENESS_THRESHOLDS,
    control_plane: {
      service: "agent-bus-control-plane",
      version: VERSION,
      pid: process.pid,
      started_at: STARTED_AT,
      note: "A response through http://127.0.0.1:18091 proves the Mac SSH tunnel and control plane are both reachable.",
    },
    agents: agents.map((agent) => {
      const liveness = agent.liveness || {};
      const lastHeartbeat = liveness.last_heartbeat || null;
      const receiptTimes = items
        .filter((item) => item.receipt_ref && item.current_assignment?.agent_id === agent.agent_id)
        .map((item) => item.updated_at)
        .sort();
      return {
        agent_id: agent.agent_id,
        display_name: agent.display_name,
        type: agent.type,
        lifecycle_status: agent.lifecycle_status || "active",
        connection: agent.type === "claude-code" || agent.type === "claude-generic" ? "channel" : "bridge",
        liveness: classifyLiveness(lastHeartbeat, nowMs),
        state: liveness.state || "unknown",
        current_thread_id: liveness.current_thread_id || null,
        queue_depth: liveness.queue_depth ?? null,
        host: liveness.host || null,
        pid: liveness.pid ?? null,
        bridge_version: liveness.bridge_version || null,
        last_heartbeat: lastHeartbeat,
        seconds_since_heartbeat: lastHeartbeat ? Math.round((nowMs - new Date(lastHeartbeat).getTime()) / 1000) : null,
        last_seen: agent.last_seen || null,
        last_receipt_at: receiptTimes.at(-1) || null,
      };
    }),
  };
}

async function overview(root, selectorPath) {
  const [items, agents, threads, usage, selector] = await Promise.all([
    listWorkItems({}, root),
    listAgents(root),
    listThreads(root),
    getUsageSummary(root),
    loadModelSelector(selectorPath),
  ]);
  return {
    counts: {
      proposed: items.filter((item) => item.status === "proposed").length,
      ready: items.filter((item) => item.status === "ready").length,
      active: items.filter((item) => item.status === "in_progress").length,
      blocked: items.filter((item) => item.status === "blocked").length,
      review: items.filter((item) => item.status === "review").length,
      done: items.filter((item) => item.status === "done").length,
    },
    recent_work: items.slice(0, 12),
    agents: deriveAgents(agents, items),
    recent_threads: threads.slice(0, 12),
    usage,
    selector: {
      status: selector.status,
      schema_version: selector.schema_version,
      last_verified: selector.last_verified || null,
      next_review: selector.next_review || null,
      warnings: selector.warnings,
      ...selector.summary,
    },
  };
}

export function createControlPlane({
  root = getBusRoot(),
  writeToken = process.env.AGENT_BUS_WRITE_TOKEN || null,
  basePath = process.env.AGENT_BUS_BASE_PATH || "",
  selectorPath = process.env.AGENT_BUS_SELECTOR_PATH || null,
  logger = () => {},
} = {}) {
  const normalizedBasePath = normalizeBasePath(basePath);
  return createServer(async (request, response) => {
    const startedAt = Date.now();
    response.once("finish", () => {
      const quietRead = response.statusCode < 400
        && ((request.method === "GET"
          && /\/(?:healthz|version)(?:\?|$)|\/api\/v1\/inbox(?:\?|$)|\/api\/v1\/agents\/status(?:\?|$)/.test(request.url || ""))
          || (request.method === "POST" && /\/api\/v1\/agents\/heartbeat(?:\?|$)/.test(request.url || "")));
      if (!quietRead) {
        logger({
          event: "http_request",
          method: request.method,
          path: request.url,
          status: response.statusCode,
          duration_ms: Date.now() - startedAt,
        });
      }
    });
    try {
      const url = new URL(request.url || "/", "http://localhost");
      const originalPathname = url.pathname;
      if (normalizedBasePath && originalPathname === normalizedBasePath) {
        response.writeHead(308, { location: `${normalizedBasePath}/` });
        return response.end();
      }
      const pathname = normalizedBasePath && originalPathname.startsWith(`${normalizedBasePath}/`)
        ? originalPathname.slice(normalizedBasePath.length) || "/"
        : originalPathname;

      if (request.method === "GET" && pathname === "/healthz") {
        await ensureBusLayout(root);
        return sendJson(response, 200, { status: "ok", ok: true, service: "agent-bus-control-plane" });
      }
      if (request.method === "GET" && pathname === "/version") {
        return sendJson(response, 200, { service: "agent-bus-control-plane", version: VERSION });
      }
      if (request.method === "GET" && pathname === "/api/v1/overview") {
        return sendJson(response, 200, await overview(root, selectorPath));
      }
      if (request.method === "GET" && pathname === "/api/v1/model-selector") {
        return sendJson(response, 200, await loadModelSelector(selectorPath));
      }
      if (request.method === "GET" && pathname === "/api/v1/model-selector/routes") {
        const selector = await loadModelSelector(selectorPath);
        return sendJson(response, 200, {
          status: selector.status,
          schema_version: selector.schema_version,
          warnings: selector.warnings,
          routes: selector.routes,
          workflow_templates: selector.workflow_templates,
        });
      }
      if (request.method === "GET" && pathname === "/api/v1/work-items") {
        return sendJson(response, 200, await listWorkItems({
          status: url.searchParams.get("status") || undefined,
          agent_id: url.searchParams.get("agent_id") || undefined,
          project: url.searchParams.get("project") || undefined,
        }, root));
      }
      if (request.method === "GET" && pathname === "/api/v1/agents") {
        if (url.searchParams.get("raw") === "true") {
          return sendJson(response, 200, await listAgents(root));
        }
        const items = await listWorkItems({}, root);
        return sendJson(response, 200, deriveAgents(await listAgents(root), items));
      }
      if (request.method === "POST" && pathname === "/api/v1/agents") {
        requireWriteAccess(request, writeToken);
        return sendJson(response, 200, await registerAgent(await readJsonBody(request), root));
      }
      if (request.method === "POST" && pathname === "/api/v1/agents/heartbeat") {
        requireWriteAccess(request, writeToken);
        return sendJson(response, 200, await heartbeatAgent(await readJsonBody(request), root));
      }
      const agentLifecycle = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/lifecycle$/);
      if (request.method === "POST" && agentLifecycle) {
        requireWriteAccess(request, writeToken);
        const body = await readJsonBody(request);
        return sendJson(response, 200, await setAgentLifecycleStatus({
          agent_id: decodeURIComponent(agentLifecycle[1]),
          status: body.status,
          actor: body.actor,
        }, root));
      }
      if (request.method === "GET" && (pathname === "/api/v1/agents/status" || pathname === "/api/agents/status")) {
        return sendJson(response, 200, await agentsStatus(root));
      }
      if (request.method === "GET" && pathname === "/api/v1/threads") {
        return sendJson(response, 200, await listThreads(root));
      }
      const threadDetail = pathname.match(/^\/api\/v1\/threads\/([^/]+)$/);
      if (request.method === "GET" && threadDetail) {
        return sendJson(response, 200, await getThread({ thread_id: decodeURIComponent(threadDetail[1]) }, root));
      }
      if (request.method === "GET" && pathname === "/api/v1/inbox") {
        return sendJson(response, 200, await readInbox({
          agent: url.searchParams.get("agent"),
          include_read: url.searchParams.get("include_read") === "true",
        }, root));
      }
      if (request.method === "GET" && pathname === "/api/v1/artifacts") {
        return sendJson(response, 200, await readArtifactManifest(root));
      }
      if (request.method === "POST" && pathname === "/api/v1/artifacts/upload") {
        requireWriteAccess(request, writeToken);
        return sendJson(response, 201, await uploadSharedArtifact(await readJsonBody(request), root));
      }
      const artifactDetail = pathname.match(/^\/api\/v1\/artifacts\/([^/]+)$/);
      if (request.method === "GET" && artifactDetail) {
        return sendJson(response, 200, await readArtifactContent(decodeURIComponent(artifactDetail[1]), root));
      }
      if (request.method === "POST" && pathname === "/api/v1/messages") {
        requireWriteAccess(request, writeToken);
        return sendJson(response, 201, await sendMessage(await readJsonBody(request), root));
      }
      const messageAction = pathname.match(/^\/api\/v1\/messages\/([^/]+)\/(ack|read)$/);
      if (request.method === "POST" && messageAction) {
        requireWriteAccess(request, writeToken);
        const args = { message_id: decodeURIComponent(messageAction[1]) };
        return sendJson(response, 200, await (messageAction[2] === "ack" ? ackMessage(args, root) : markRead(args, root)));
      }
      const threadReply = pathname.match(/^\/api\/v1\/threads\/([^/]+)\/reply$/);
      if (request.method === "POST" && threadReply) {
        requireWriteAccess(request, writeToken);
        return sendJson(response, 201, await replyMessage({
          ...(await readJsonBody(request)),
          thread_id: decodeURIComponent(threadReply[1]),
        }, root));
      }
      const threadStatus = pathname.match(/^\/api\/v1\/threads\/([^/]+)\/status$/);
      if (request.method === "POST" && threadStatus) {
        requireWriteAccess(request, writeToken);
        const body = await readJsonBody(request);
        return sendJson(response, 200, await updateThreadStatus({
          thread_id: decodeURIComponent(threadStatus[1]),
          status: body.status,
          reason: body.reason,
          actor: body.actor,
        }, root));
      }
      if (request.method === "GET" && pathname === "/api/v1/usage") {
        return sendJson(response, 200, await getUsageSummary(root));
      }
      if (request.method === "POST" && pathname === "/api/v1/work-items") {
        requireWriteAccess(request, writeToken);
        return sendJson(response, 201, await createWorkItem(await readJsonBody(request), root));
      }

      const selectorTemplate = pathname.match(/^\/api\/v1\/model-selector\/templates\/([^/]+)\/propose$/);
      if (request.method === "POST" && selectorTemplate) {
        requireWriteAccess(request, writeToken);
        const selector = await loadModelSelector(selectorPath);
        const workflow = buildWorkflowProposals(selector, decodeURIComponent(selectorTemplate[1]), await readJsonBody(request));
        const created = [];
        for (const proposal of workflow.proposals) created.push(await createWorkItem(proposal, root));
        return sendJson(response, 201, { ...workflow, proposals: undefined, created });
      }

      const detailMatch = pathname.match(/^\/api\/v1\/work-items\/([^/]+)$/);
      if (request.method === "GET" && detailMatch) {
        const workItemId = decodeURIComponent(detailMatch[1]);
        const [item, events, receipt] = await Promise.all([
          getWorkItem({ work_item_id: workItemId }, root),
          listWorkItemEvents({ work_item_id: workItemId }, root),
          getWorkItemReceipt({ work_item_id: workItemId }, root),
        ]);
        return sendJson(response, 200, { item, events, receipt });
      }
      const receiptMatch = pathname.match(/^\/api\/v1\/work-items\/([^/]+)\/receipt$/);
      if (request.method === "GET" && receiptMatch) {
        const receipt = await getWorkItemReceipt({ work_item_id: decodeURIComponent(receiptMatch[1]) }, root);
        if (!receipt) return sendJson(response, 404, { error: "No receipt has been submitted for this work item" });
        return sendJson(response, 200, receipt);
      }

      const actions = [
        ["transition", transitionWorkItem],
        ["assign", assignWorkItem],
        ["runs", startRun],
        ["receipt", submitReceipt],
        ["review", reviewWorkItem],
      ];
      for (const [suffix, operation] of actions) {
        const workItemId = routeMatch(pathname, suffix);
        if (request.method === "POST" && workItemId) {
          requireWriteAccess(request, writeToken);
          const body = await readJsonBody(request);
          return sendJson(response, 200, await operation({ ...body, work_item_id: workItemId }, root));
        }
      }

      const runMatch = pathname.match(/^\/api\/v1\/work-items\/([^/]+)\/runs\/([^/]+)$/);
      if (request.method === "POST" && runMatch) {
        requireWriteAccess(request, writeToken);
        const body = await readJsonBody(request);
        return sendJson(response, 200, await updateRun({
          ...body,
          work_item_id: decodeURIComponent(runMatch[1]),
          run_id: decodeURIComponent(runMatch[2]),
        }, root));
      }

      if (request.method === "GET" && STATIC_FILES[pathname]) {
        const [filename, contentType] = STATIC_FILES[pathname];
        let body = await readFile(path.join(STATIC_ROOT, filename));
        if (filename === "index.html") {
          body = Buffer.from(body.toString("utf8").replaceAll("__AGENT_BUS_BASE_PATH__", normalizedBasePath));
        }
        response.writeHead(200, {
          "content-type": contentType,
          "content-length": body.length,
          "cache-control": "no-cache",
          "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        });
        return response.end(body);
      }

      return sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      logger({ event: "request_error", level: "ERROR", method: request.method, path: request.url, error: error instanceof Error ? error.message : String(error) });
      const status = error.statusCode || (String(error.message).includes("not found") ? 404 : 400);
      return sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function startControlPlane({
  root = getBusRoot(),
  host = process.env.AGENT_BUS_HOST || "127.0.0.1",
  port = Number(process.env.AGENT_BUS_PORT || 8091),
  writeToken = process.env.AGENT_BUS_WRITE_TOKEN || null,
  basePath = process.env.AGENT_BUS_BASE_PATH || "",
  selectorPath = process.env.AGENT_BUS_SELECTOR_PATH || null,
  logDirectory = process.env.AGENT_BUS_LOG_DIR || null,
} = {}) {
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("Control plane must bind to localhost; use a private reverse proxy for remote access");
  }
  const logger = await createFileLogger(logDirectory);
  const server = createControlPlane({ root, writeToken, basePath, selectorPath, logger });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  logger({ event: "service_started", host, port, base_path: normalizeBasePath(basePath), version: VERSION });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = await startControlPlane();
  const address = server.address();
  process.stdout.write(`Agent Bus control plane listening on http://${address.address}:${address.port}\n`);
}
