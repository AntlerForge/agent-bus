import test from "node:test";
import assert from "node:assert/strict";
import { lintState } from "../src/state-lint.mjs";

test("state lint detects impossible runs, stale threads, and ambiguous zero usage", () => {
  const findings = lintState({
    now: Date.parse("2026-07-18T12:00:00Z"), staleHours: 24,
    items: [{ work_item_id: "work_1", status: "review", runs: [{ run_id: "run_1", status: "running", updated_at: "2026-07-18T11:00:00Z", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }] }],
    threads: [{ thread_id: "thread_1", status: "blocked", updated: "2026-07-15T11:00:00Z", subject: "completed revision" }],
  });
  assert.deepEqual(findings.map((item) => item.code), ["RUN_ACTIVE_UNDER_TERMINAL_WORK", "THREAD_STALE_OPEN", "USAGE_ZERO_AMBIGUOUS"]);
});
