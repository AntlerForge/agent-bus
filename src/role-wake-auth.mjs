import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROLE_WAKE_CALLERS = Object.freeze(["tony", "chief-of-staff", "estate-operations-manager"]);
export const ROLE_WAKE_WORKER = "mac-role-wake-worker";
export const ROLE_WAKE_MONITOR = "estate-operations-monitor";

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseRoleWakeCredentials(value) {
  const entries = Array.isArray(value?.credentials) ? value.credentials : [];
  const credentials = new Map();
  for (const entry of entries) {
    const identity = String(entry?.identity || "").trim();
    const kind = String(entry?.kind || "").trim();
    const tokenSha256 = String(entry?.token_sha256 || "").trim().toLowerCase();
    if (!identity || !["caller", "worker", "monitor"].includes(kind) || !/^[a-f0-9]{64}$/.test(tokenSha256)) {
      throw new Error("Invalid role-wake credential entry");
    }
    if (credentials.has(identity)) throw new Error(`Duplicate role-wake credential identity: ${identity}`);
    credentials.set(identity, { identity, kind, token_sha256: tokenSha256 });
  }
  return credentials;
}

export function loadRoleWakeCredentials(filePath = process.env.AGENT_BUS_ROLE_WAKE_CREDENTIALS_FILE) {
  if (!filePath) return new Map();
  return parseRoleWakeCredentials(JSON.parse(readFileSync(filePath, "utf8")));
}

export function authenticateRoleWake(request, credentials, allowedKind) {
  const identity = String(request.headers["x-agent-bus-role-wake-identity"] || "").trim();
  const token = String(request.headers["x-agent-bus-role-wake-token"] || "").trim();
  const credential = credentials.get(identity);
  if (!credential || credential.kind !== allowedKind || !token || !secureEqual(credential.token_sha256, sha256(token))) {
    const error = new Error("Valid role-wake credentials are required");
    error.statusCode = 401;
    throw error;
  }
  if (allowedKind === "caller" && !ROLE_WAKE_CALLERS.includes(identity)) {
    const error = new Error("Caller is not sanctioned to wake roles");
    error.statusCode = 403;
    throw error;
  }
  if (allowedKind === "worker" && identity !== ROLE_WAKE_WORKER) throw new Error("Unexpected role-wake worker identity");
  if (allowedKind === "monitor" && identity !== ROLE_WAKE_MONITOR) throw new Error("Unexpected role-wake monitor identity");
  return credential;
}

function tokenFromFile(filePath) {
  const line = readFileSync(filePath, "utf8").split(/\r?\n/).find((item) => item.startsWith("AGENT_BUS_ROLE_WAKE_TOKEN="));
  return line?.slice("AGENT_BUS_ROLE_WAKE_TOKEN=".length).trim() || null;
}

export function getRoleWakeCredential(env = process.env) {
  const identity = String(env.AGENT_BUS_ROLE_WAKE_IDENTITY || "").trim();
  const filePath = env.AGENT_BUS_ROLE_WAKE_TOKEN_FILE || path.join(os.homedir(), ".config", "agent-bus", "role-wake-token.env");
  let token = String(env.AGENT_BUS_ROLE_WAKE_TOKEN || "").trim();
  if (!token) {
    try { token = tokenFromFile(filePath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return identity && token ? { identity, token } : null;
}
