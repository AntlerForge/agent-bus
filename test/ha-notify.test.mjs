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
    assert.match(requests[0].body.title, /APPROVAL 1/); assert.equal(requests[0].body.data.actions.length, 2);
    assert.match(requests[0].body.data.subtitle, /Press and hold/);
    assert.deepEqual(decodeAction(requests[0].body.data.actions[0].action), { decision: "YES", id: "approval-123" });
    assert.equal(JSON.parse(await readFile(path.join(stateDirectory, `${Buffer.from("approval-123").toString("base64url")}.json`), "utf8")).id, "approval-123");
  } finally { await rm(root, { recursive: true, force: true }); }
});
