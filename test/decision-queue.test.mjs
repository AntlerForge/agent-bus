import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const config = YAML.parse(await fs.readFile("config/decision-queue-sla.v1.yaml", "utf8"));
const source = await fs.readFile("scripts/decision-queue.mjs", "utf8");

test("decision queue keeps the audit baseline and bounded weekly contract", () => {
  assert.deepEqual(config.baseline_oracle.required_flag_ids, ["F001", "F002"]);
  assert.equal(config.baseline_oracle.sentinel_cards, 8);
  assert.equal(config.baseline_oracle.bus_items, 5);
  assert.equal(config.baseline_oracle.overdue_tasks, 14);
  assert.ok(config.weekly_limit <= 20);
});

test("decision queue is read-only toward source authorities", () => {
  for (const required of ["outcome-truth/cards.json", "work-ledger/items", "holding-pen", "agent-flags.md", "todo-list.md", "day-board.md", "pending-approvals.jsonl"])
    assert.match(source, new RegExp(required.replaceAll(".", "\\.")));
  assert.doesNotMatch(source, /ingest\.py|board\.py|writeFile\([^)]*vault|APPROVAL/);
  assert.match(source, /expiry_draft/);
  assert.match(source, /newBreaches/);
});
