#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeJsonFileAtomic } from "../src/io.mjs";

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => {
    const at = line.indexOf("="); let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return [line.slice(0, at), value];
  }));
}

export function decodeAction(action) {
  const match = String(action || "").match(/^AGENT_BUS_APPROVAL_(YES|NO)_([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  return { decision: match[1], id: Buffer.from(match[2], "base64url").toString("utf8") };
}

const envFile = process.env.HA_NOTIFY_ENV_FILE || "/home/ajbarfoot/Developer/ha-agent-pilot/.env";
const responseDirectory = process.env.HA_APPROVAL_RESPONSE_DIR || "/srv/projects/Personal/agent-bus/runtime/ha-notify/responses";

function connect(wsUrl, env) {
  const socket = new WebSocket(wsUrl);
  socket.addEventListener("message", async ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: env.HASS_TOKEN }));
    else if (message.type === "auth_ok") socket.send(JSON.stringify({ id: 1, type: "subscribe_events", event_type: "mobile_app_notification_action" }));
    else if (message.type === "event") {
      const decoded = decodeAction(message.event?.data?.action);
      if (!decoded) return;
      const response = { approval_id: decoded.id, decision: decoded.decision, captured_at: new Date().toISOString(), ha_time_fired: message.event.time_fired || null, device_id: message.event.data.device_id || null };
      await writeJsonFileAtomic(path.join(responseDirectory, `${Buffer.from(decoded.id).toString("base64url")}.json`), response);
      process.stdout.write(`${JSON.stringify({ event: "approval_captured", approval_id: decoded.id, decision: decoded.decision, captured_at: response.captured_at })}\n`);
    }
  });
  socket.addEventListener("close", () => setTimeout(() => connect(wsUrl, env), 3000));
  socket.addEventListener("error", () => socket.close());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = parseEnv(await readFile(envFile, "utf8"));
  await mkdir(responseDirectory, { recursive: true });
  const wsUrl = `${env.HASS_URL.replace(/^http/, "ws").replace(/\/+$/, "")}/api/websocket`;
  connect(wsUrl, env);
}
