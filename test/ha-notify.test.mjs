import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { notifyTony } from "../scripts/ha-notify-tony.mjs";
import { decodeAction } from "../scripts/ha-approval-listener.mjs";

test("notifier distinguishes classes and atomically deduplicates stable ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ha-notify-test-"));
  try {
    const envFile = path.join(root, ".env"); const configFile = path.join(root, "config.json"); const stateDirectory = path.join(root, "sends");
    await writeFile(envFile, "HASS_URL=http://ha.test\nHASS_TOKEN=test-only\n");
    await writeFile(configFile, JSON.stringify({ services: ["mobile_app_phone"] }));
    const requests = [];
    const options = { className: "APPROVAL", id: "approval-123", message: "APPROVAL 1: Continue?", approvalNumber: "1", envFile, configFile, stateDirectory };
    const first = await notifyTony(options, { fetchImpl: async (url, request) => { requests.push({ url, body: JSON.parse(request.body) }); return { ok: true }; } });
    const second = await notifyTony(options, { fetchImpl: async () => { throw new Error("duplicate must not send"); } });
    assert.equal(first.deduplicated, false); assert.equal(second.deduplicated, true); assert.equal(requests.length, 1);
    assert.match(requests[0].body.title, /Agent Bus approval 1/); assert.equal(requests[0].body.data.actions.length, 2);
    assert.match(requests[0].body.data.subtitle, /Press and hold/);
    assert.deepEqual(decodeAction(requests[0].body.data.actions[0].action), { decision: "YES", id: "approval-123" });
    assert.equal(JSON.parse(await readFile(path.join(stateDirectory, `${Buffer.from("approval-123").toString("base64url")}.json`), "utf8")).id, "approval-123");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("INFO and ALERT notifications carry an explicit tap URL without weakening deduplication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ha-notify-url-test-"));
  try {
    const envFile = path.join(root, ".env"); const configFile = path.join(root, "config.json"); const stateDirectory = path.join(root, "sends");
    await writeFile(envFile, "HASS_URL=http://ha.test\nHASS_TOKEN=test-only\n");
    await writeFile(configFile, JSON.stringify({ services: ["mobile_app_phone"] }));
    for (const className of ["INFO", "ALERT"]) {
      const requests = [];
      const url = `http://antler-a6:8088/Projects/Personal/agent-bus/runtime/decision-queue/${className.toLowerCase()}.md`;
      const options = { className, id: `url-${className}`, message: "Tap to open", url, envFile, configFile, stateDirectory };
      const first = await notifyTony(options, { fetchImpl: async (_url, request) => { requests.push(JSON.parse(request.body)); return { ok: true, status: 200 }; } });
      const second = await notifyTony(options, { fetchImpl: async () => { throw new Error("duplicate must not send"); } });
      const mobile = requests.find((request) => request.data?.url);
      assert.equal(mobile.data.url, url);
      assert.match(mobile.title, /Agent Bus/);
      if (className === "ALERT") {
        const persistent = requests.find((request) => request.notification_id);
        assert.match(persistent.message, /Open the relevant page/);
      }
      assert.equal(first.url, url);
      assert.equal(second.deduplicated, true);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ALERT can retain a full report under one stable Home Assistant notification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ha-notify-persistent-test-"));
  try {
    const envFile = path.join(root, ".env"); const configFile = path.join(root, "config.json"); const stateDirectory = path.join(root, "sends");
    const reportFile = path.join(root, "report.md");
    await writeFile(envFile, "HASS_URL=http://ha.test\nHASS_TOKEN=test-only\n");
    await writeFile(configFile, JSON.stringify({ services: ["mobile_app_phone"] }));
    await writeFile(reportFile, "# Queue detail\n\n- First item\n- Second item\n");
    const requests = [];
    const options = {
      className: "ALERT", id: "queue-alert-1", message: "Two mixed review items", url: "https://kv.example/#tasks",
      persistentId: "agent-bus-decision-queue-breach", persistentMessageFile: reportFile,
      envFile, configFile, stateDirectory,
    };
    const result = await notifyTony(options, { fetchImpl: async (url, request) => {
      requests.push({ url, body: JSON.parse(request.body) }); return { ok: true, status: 200 };
    } });
    const persistent = requests.find((request) => request.url.endsWith("/persistent_notification/create"));
    assert.equal(requests.length, 2);
    assert.equal(persistent.body.notification_id, "agent-bus-decision-queue-breach");
    assert.match(persistent.body.message, /First item/);
    assert.equal(result.persistent_notification.accepted, true);
    assert.match(result.title, /Agent Bus/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("notifier defaults to Estate Status and rejects raw JSON URLs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ha-notify-status-test-"));
  try {
    const envFile = path.join(root, ".env"); const configFile = path.join(root, "config.json"); const stateDirectory = path.join(root, "sends");
    const defaultUrl = "http://antler-a6:8088/Projects/Personal/agent-bus/runtime/estate-status/estate-status.md";
    await writeFile(envFile, "HASS_URL=http://ha.test\nHASS_TOKEN=test-only\n");
    await writeFile(configFile, JSON.stringify({ services: ["mobile_app_phone"], default_url: defaultUrl }));
    const requests = [];
    const options = { className: "INFO", id: "estate-status-default", message: "Status updated", envFile, configFile, stateDirectory };
    const result = await notifyTony(options, { fetchImpl: async (_url, request) => { requests.push(JSON.parse(request.body)); return { ok: true }; } });
    assert.equal(result.url, defaultUrl);
    assert.equal(requests[0].data.url, defaultUrl);
    await assert.rejects(() => notifyTony({ ...options, id: "raw-json-rejected", url: "http://antler-a6/private/queue.json" }, { fetchImpl: async () => ({ ok: true }) }), /must not point at machine-readable JSON/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
