#!/usr/bin/env node
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeJsonFileAtomic } from "../src/io.mjs";

const CLASSES = new Set(["ALERT", "APPROVAL", "INFO"]);

function parseArgs(argv) {
  const options = {
    className: null, id: null, message: null, approvalNumber: null, url: null,
    envFile: process.env.HA_NOTIFY_ENV_FILE || "/home/ajbarfoot/Developer/ha-agent-pilot/.env",
    configFile: process.env.HA_NOTIFY_CONFIG || "/srv/projects/Personal/agent-bus/runtime/ha-notify/config.json",
    stateDirectory: process.env.HA_NOTIFY_STATE_DIR || "/srv/projects/Personal/agent-bus/runtime/ha-notify/sends",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]; const value = argv[index + 1];
    if (key === "--class") { options.className = String(value || "").toUpperCase(); index += 1; }
    else if (key === "--id") { options.id = value; index += 1; }
    else if (key === "--message") { options.message = value; index += 1; }
    else if (key === "--approval-number") { options.approvalNumber = value; index += 1; }
    else if (key === "--url") { options.url = value; index += 1; }
    else if (key === "--env-file") { options.envFile = value; index += 1; }
    else if (key === "--config") { options.configFile = value; index += 1; }
    else throw new Error(`Unsupported argument: ${key}`);
  }
  if (!CLASSES.has(options.className)) throw new Error("--class must be ALERT, APPROVAL, or INFO");
  if (!options.id || !/^[A-Za-z0-9._:-]{3,160}$/.test(options.id)) throw new Error("--id must be a stable 3-160 character identifier");
  if (!options.message || /[\r\n]/.test(options.message)) throw new Error("--message must be one line");
  if (options.url) {
    let parsed;
    try { parsed = new URL(options.url); } catch { throw new Error("--url must be an absolute URL"); }
    if (!["http:", "https:", "homeassistant:"].includes(parsed.protocol)) throw new Error("--url must use http, https, or homeassistant");
    if (/\.json$/i.test(parsed.pathname)) throw new Error("--url must not point at machine-readable JSON");
  }
  if (options.className === "APPROVAL" && !options.approvalNumber) throw new Error("APPROVAL requires --approval-number");
  return options;
}

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => {
    const split = line.indexOf("=");
    const key = line.slice(0, split); let value = line.slice(split + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return [key, value];
  }));
}

function actionName(decision, id) {
  return `AGENT_BUS_APPROVAL_${decision}_${Buffer.from(id).toString("base64url")}`;
}

function notificationPayload(options, resolvedUrl) {
  const titles = {
    ALERT: "🚨 ALERT — action needed",
    APPROVAL: `✅ APPROVAL ${options.approvalNumber} — tap YES or NO`,
    INFO: "ℹ️ INFO — all clear",
  };
  const data = { tag: `agent-bus:${options.id}`, group: "agent-bus", url: resolvedUrl };
  if (options.className === "ALERT") data.push = { sound: "default", "interruption-level": "time-sensitive" };
  if (options.className === "INFO") data.push = { "interruption-level": "passive" };
  if (options.className === "APPROVAL") {
    data.subtitle = "Press and hold this notification to reveal YES / NO";
    data.actions = [
      { action: actionName("YES", options.id), title: "YES", icon: "sfsymbols:checkmark.circle" },
      { action: actionName("NO", options.id), title: "NO", destructive: true, icon: "sfsymbols:xmark.circle" },
    ];
  }
  return { title: titles[options.className], message: options.message, data };
}

export async function notifyTony(options, { fetchImpl = fetch } = {}) {
  const startedAt = new Date().toISOString();
  const safeId = Buffer.from(options.id).toString("base64url");
  await mkdir(options.stateDirectory, { recursive: true });
  const claimFile = path.join(options.stateDirectory, `${safeId}.json`);
  let claim;
  try { claim = await open(claimFile, "wx", 0o600); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(claimFile, "utf8"));
    return { ...existing, deduplicated: true };
  }
  try {
    const env = parseEnv(await readFile(options.envFile, "utf8"));
    const config = JSON.parse(await readFile(options.configFile, "utf8"));
    const services = Array.isArray(config.services) ? config.services : [];
    if (!env.HASS_URL || !env.HASS_TOKEN || !services.length) throw new Error("HA URL, token, and notification services are required");
    const resolvedUrl = options.url || config.default_url || "/lovelace/default_view";
    if (/\.json(?:$|[?#])/i.test(resolvedUrl)) throw new Error("Notification URL must not point at machine-readable JSON");
    const payload = notificationPayload(options, resolvedUrl);
    const deliveries = [];
    for (const service of services) {
      const response = await fetchImpl(`${env.HASS_URL.replace(/\/+$/, "")}/api/services/notify/${encodeURIComponent(service)}`, {
        method: "POST", headers: { authorization: `Bearer ${env.HASS_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`HA notify service ${service} failed (${response.status})`);
      deliveries.push({ service, accepted_at: new Date().toISOString() });
    }
    const result = { id: options.id, class: options.className, url: resolvedUrl, started_at: startedAt, sent_at: new Date().toISOString(), deduplicated: false, deliveries };
    await claim.writeFile(`${JSON.stringify(result, null, 2)}\n`); await claim.sync(); await claim.close(); claim = null;
    return result;
  } catch (error) {
    if (claim) await claim.close().catch(() => {});
    await unlink(claimFile).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await notifyTony(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
