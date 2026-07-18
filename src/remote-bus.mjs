import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function request(baseUrl, pathname, { method = "GET", body, writeToken } = {}) {
  const response = await fetch(`${normalizeUrl(baseUrl)}${pathname}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(writeToken ? { authorization: `Bearer ${writeToken}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(`Remote Agent Bus request failed (${response.status}): ${value.error || "Unknown error"}`);
  }
  return value;
}

export function createRemoteBus(baseUrl, { writeToken = null } = {}) {
  if (!normalizeUrl(baseUrl)) throw new Error("Agent Bus control-plane URL is required");
  const write = (pathname, body) => request(baseUrl, pathname, { method: "POST", body, writeToken });

  async function uploadArtifact(filePath) {
    let content;
    try {
      content = await readFile(filePath);
    } catch (error) {
      if (error.code === "ENOENT" && String(filePath).startsWith("/data/shared/")) {
        return { path: filePath, uploaded: false };
      }
      throw error;
    }
    return write("/api/v1/artifacts/upload", {
      filename: path.basename(filePath),
      content_base64: content.toString("base64"),
    });
  }

  async function prepareArtifacts(args) {
    if (!args.artifact_paths?.length) return args;
    const uploaded = [];
    for (const filePath of args.artifact_paths) {
      uploaded.push(await uploadArtifact(filePath));
    }
    return { ...args, artifact_paths: uploaded.map((artifact) => artifact.path) };
  }

  return {
    async sendMessage(args) {
      return write("/api/v1/messages", await prepareArtifacts(args));
    },
    readInbox(args) {
      const query = new URLSearchParams({ agent: args.agent });
      if (args.include_read) query.set("include_read", "true");
      return request(baseUrl, `/api/v1/inbox?${query}`);
    },
    async replyMessage(args) {
      return write(`/api/v1/threads/${encodeURIComponent(args.thread_id)}/reply`, await prepareArtifacts(args));
    },
    ackMessage(args) {
      return write(`/api/v1/messages/${encodeURIComponent(args.message_id)}/ack`, {});
    },
    markRead(args) {
      return write(`/api/v1/messages/${encodeURIComponent(args.message_id)}/read`, {});
    },
    updateThreadStatus(args) {
      return write(`/api/v1/threads/${encodeURIComponent(args.thread_id)}/status`, { status: args.status });
    },
    listThreads() {
      return request(baseUrl, "/api/v1/threads");
    },
    getThread(args) {
      return request(baseUrl, `/api/v1/threads/${encodeURIComponent(args.thread_id)}`);
    },
    registerAgent(args) {
      return write("/api/v1/agents", args);
    },
    listAgents() {
      return request(baseUrl, "/api/v1/agents?raw=true");
    },
    listArtifacts() {
      return request(baseUrl, "/api/v1/artifacts");
    },
    getArtifact(artifactId) {
      return request(baseUrl, `/api/v1/artifacts/${encodeURIComponent(artifactId)}`);
    },
    async materializeMessageArtifacts(message, directory) {
      if (!message.artifacts?.length) return [];
      await mkdir(directory, { recursive: true });
      const materialized = [];
      for (const artifactId of message.artifacts) {
        const artifact = await request(baseUrl, `/api/v1/artifacts/${encodeURIComponent(artifactId)}`);
        const safeFilename = path.basename(artifact.filename || `${artifactId}.bin`).replace(/[^A-Za-z0-9._-]/g, "_");
        const localPath = path.join(directory, `${artifactId}-${safeFilename}`);
        await writeFile(localPath, Buffer.from(artifact.content_base64, "base64"));
        materialized.push({ ...artifact, local_path: localPath, content_base64: undefined });
      }
      return materialized;
    },
  };
}

let cached;

export function configuredRemoteBus() {
  const baseUrl = process.env.AGENT_BUS_CONTROL_PLANE_URL;
  if (!baseUrl) return null;
  if (!cached || cached.baseUrl !== baseUrl || cached.writeToken !== (process.env.AGENT_BUS_WRITE_TOKEN || null)) {
    cached = {
      baseUrl,
      writeToken: process.env.AGENT_BUS_WRITE_TOKEN || null,
      client: createRemoteBus(baseUrl, { writeToken: process.env.AGENT_BUS_WRITE_TOKEN || null }),
    };
  }
  return cached.client;
}
