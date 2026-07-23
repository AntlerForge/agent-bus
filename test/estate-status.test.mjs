import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderBreachSummary, renderEstateStatus } from "../src/estate-status/render.mjs";

test("Estate Status renders cards, queue metrics, alerts and links without JSON", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "estate-status-"));
  const statusUrl = "https://kv.antlerforge.com/#tasks";
  try {
    await fs.mkdir(path.join(root, "outcome-truth"), { recursive: true });
    await fs.mkdir(path.join(root, "decision-queue"), { recursive: true });
    await fs.mkdir(path.join(root, "ha-notify", "sends"), { recursive: true });
    await fs.writeFile(path.join(root, "outcome-truth", "cards.json"), JSON.stringify({ c: { check_id: "borg-freshness", status: "open", first_seen: "2026-07-22T01:00:00Z", last_seen: "2026-07-22T02:00:00Z", actual: 181, recovery_contract: "observe a fresh archive" } }));
    const queue = { metrics: { count: 4, breached: 2, p50_age_hours: 12, p90_age_hours: 72 }, items: [{ id: "task:T1", title: "Decide this", age_hours: 72, sla_hours: 48, action: "Approve or reject" }] };
    await fs.writeFile(path.join(root, "decision-queue", "queue.json"), JSON.stringify(queue));
    await fs.writeFile(path.join(root, "decision-queue", "decision-pack-2026-07-22.md"), "# Pack\n");
    await fs.writeFile(path.join(root, "ha-notify", "sends", "one.json"), JSON.stringify({ id: "outcome-estate:borg-freshness-opened-2026-07-22T01:00:00Z", class: "ALERT", sent_at: "2026-07-22T01:00:01Z" }));
    const outputFile = path.join(root, "estate-status", "estate-status.md");
    await renderBreachSummary({ snapshot: queue, newBreaches: ["task:T1"], outputFile: path.join(root, "decision-queue", "breach-summary.md"), statusUrl });
    await renderEstateStatus({ runtimeRoot: root, outputFile, statusUrl, generatedAt: "2026-07-22T03:00:00Z" });
    const page = await fs.readFile(outputFile, "utf8");
    const breach = await fs.readFile(path.join(root, "decision-queue", "breach-summary.md"), "utf8");
    assert.match(page, /borg freshness/);
    assert.match(page, /Breached SLA: 2/);
    assert.match(page, /currently open/);
    assert.match(page, /Latest decision pack/);
    assert.doesNotMatch(page, /\.json/);
    assert.match(breach, /Waiting: 3d/);
    assert.match(breach, /Approve or reject/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
