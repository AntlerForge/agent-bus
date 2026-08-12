import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
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
} from "../src/work-ledger/store.mjs";
import { ensureBusLayout } from "../src/paths.mjs";

async function withBusRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-work-ledger-test-"));
  try {
    await ensureBusLayout(root);
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createReadyWork(root, overrides = {}) {
  const item = await createWorkItem(
    {
      title: "Implement dashboard",
      objective: "Build the smallest useful task dashboard.",
      source_ref: "BL119",
      acceptance_criteria: ["Tasks are visible"],
      ...overrides,
    },
    root,
  );
  return transitionWorkItem({ work_item_id: item.work_item_id, status: "ready", actor: "tony" }, root);
}

test("work items are human-readable and proposals need owner approval", async () => {
  await withBusRoot(async (root) => {
    const item = await createWorkItem(
      { title: "Review", objective: "Review the implementation.", source_ref: "BL119", proposed_by: "codex" },
      root,
    );
    assert.equal(item.status, "proposed");
    await assert.rejects(
      () => transitionWorkItem({ work_item_id: item.work_item_id, status: "ready", actor: "codex" }, root),
      /human owner or an explicit policy/,
    );
    const ready = await transitionWorkItem(
      { work_item_id: item.work_item_id, status: "ready", actor: "tony", reason: "Approved" },
      root,
    );
    assert.equal(ready.status, "ready");
    const raw = await readFile(ready.paths.item, "utf8");
    assert.match(raw, /source_ref: BL119/);
    assert.match(raw, /Review the implementation/);
  });
});

test("assignment, run, usage, receipt and no-review completion form one lifecycle", async () => {
  await withBusRoot(async (root) => {
    const ready = await createReadyWork(root, { budget_tokens: 10000 });
    const assigned = await assignWorkItem(
      { work_item_id: ready.work_item_id, agent_id: "codex", assigned_by: "tony" },
      root,
    );
    assert.equal(assigned.current_assignment.agent_id, "codex");

    const started = await startRun(
      { work_item_id: ready.work_item_id, actor: "codex", provider: "openai", thread_id: "thread_demo" },
      root,
    );
    assert.equal(started.work_item.status, "in_progress");
    const updated = await updateRun(
      {
        work_item_id: ready.work_item_id,
        run_id: started.run.run_id,
        status: "submitted",
        actor: "codex",
        input_tokens: 1200,
        output_tokens: 300,
        estimated_cost: 0.25,
      },
      root,
    );
    assert.equal(updated.run.usage.total_tokens, 1500);

    const completed = await submitReceipt(
      {
        work_item_id: ready.work_item_id,
        submitted_by: "codex",
        outcome: "success",
        summary: "Dashboard implemented and tested.",
        evidence: [{ target_state: "Test suite passes", location: "test/", verify: "npm test" }],
        deliverables: ["src/control-plane/server.mjs"],
      },
      root,
    );
    assert.equal(completed.work_item.status, "done");
    assert.ok(completed.work_item.receipt_ref);

    const usage = await getUsageSummary(root);
    assert.equal(usage.total_tokens, 1500);
    assert.equal(usage.estimated_cost, 0.25);
    assert.equal(usage.by_agent.codex.total_tokens, 1500);
  });
});

test("review-gated work requires an independent agent", async () => {
  await withBusRoot(async (root) => {
    const ready = await createReadyWork(root, { review_policy: "independent_agent" });
    await assignWorkItem({ work_item_id: ready.work_item_id, agent_id: "codex" }, root);
    await startRun({ work_item_id: ready.work_item_id, actor: "codex" }, root);
    const submitted = await submitReceipt(
      {
        work_item_id: ready.work_item_id,
        submitted_by: "codex",
        outcome: "success",
        summary: "Ready for review.",
        evidence: [{ target_state: "Implementation is ready", location: "src/", verify: "npm test" }],
      },
      root,
    );
    assert.equal(submitted.work_item.status, "review");
    await assert.rejects(
      () => reviewWorkItem({ work_item_id: ready.work_item_id, reviewer: "codex", decision: "approved", summary: "Self-approved" }, root),
      /different agent/,
    );
    const reviewed = await reviewWorkItem(
      { work_item_id: ready.work_item_id, reviewer: "claude", decision: "approved", summary: "Evidence is sufficient." },
      root,
    );
    assert.equal(reviewed.work_item.status, "done");
    assert.equal(reviewed.work_item.review_status, "approved");
  });
});

test("a submitted receipt can be read back so a reviewer can see the evidence", async () => {
  await withBusRoot(async (root) => {
    const ready = await createReadyWork(root, { review_policy: "human" });
    await assignWorkItem({ work_item_id: ready.work_item_id, agent_id: "codex" }, root);
    await startRun({ work_item_id: ready.work_item_id, actor: "codex" }, root);
    assert.equal(await getWorkItemReceipt({ work_item_id: ready.work_item_id }, root), null);
    await submitReceipt({
      work_item_id: ready.work_item_id,
      submitted_by: "codex",
      outcome: "success",
      summary: "Dashboard implemented and tested.",
      evidence: [{ target_state: "Test suite passes", location: "test/", verify: "npm test" }],
      deliverables: ["src/control-plane/server.mjs"],
      limitations: ["No mobile layout"],
    }, root);
    const receipt = await getWorkItemReceipt({ work_item_id: ready.work_item_id }, root);
    assert.equal(receipt.outcome, "success");
    assert.equal(receipt.summary, "Dashboard implemented and tested.");
    assert.equal(receipt.evidence[0].verify, "npm test");
    assert.deepEqual(receipt.deliverables, ["src/control-plane/server.mjs"]);
    assert.deepEqual(receipt.limitations, ["No mobile layout"]);
  });
});

test("unknown usage remains null until the provider reports it", async () => {
  await withBusRoot(async (root) => {
    const ready = await createReadyWork(root);
    await assignWorkItem({ work_item_id: ready.work_item_id, agent_id: "codex" }, root);
    const started = await startRun({ work_item_id: ready.work_item_id, actor: "codex" }, root);
    assert.deepEqual(started.run.usage, { input_tokens: null, output_tokens: null, total_tokens: null, estimated_cost: null });
    const usage = await getUsageSummary(root);
    assert.equal(usage.total_tokens, null);
    assert.equal(usage.usage_known, false);
    assert.equal(usage.by_agent.codex.unknown_runs, 1);
  });
});

test("receipts reject process-only evidence without target-state verification", async () => {
  await withBusRoot(async (root) => {
    const ready = await createReadyWork(root);
    await assignWorkItem({ work_item_id: ready.work_item_id, agent_id: "codex" }, root);
    await startRun({ work_item_id: ready.work_item_id, actor: "codex" }, root);
    await assert.rejects(() => submitReceipt({
      work_item_id: ready.work_item_id, submitted_by: "codex", outcome: "success",
      summary: "Process exited.", evidence: ["exit 0"],
    }, root), /target_state, location, and verify/);
  });
});

test("duplicate intent replay accepts one irrigation job and flags seventeen without false controls", async () => {
  await withBusRoot(async (root) => {
    const jobs = [];
    for (let index = 1; index <= 18; index += 1) {
      jobs.push(await createWorkItem({
        title: `Garden irrigation deep research job ${index}`,
        objective: `Research reliable garden irrigation automation and recommend the same evidence-backed design. Job ${index}.`,
        source_ref: `irrigation:${index}`,
      }, root));
    }
    assert.equal(jobs.filter((item) => item.intent_guard.accepted).length, 1);
    assert.equal(jobs.filter((item) => !item.intent_guard.accepted && item.status === "canceled").length, 17);
    const controls = [];
    for (const [title, objective] of [
      ["Audit Borg restores", "Run a read-only restore drill for the A6 backup."],
      ["Review calendar", "Find scheduling conflicts in next week's calendar."],
      ["Fix dashboard CSS", "Repair mobile overflow in the Agent Bus task table."],
    ]) controls.push(await createWorkItem({ title, objective, source_ref: title }, root));
    assert.ok(controls.every((item) => item.intent_guard.accepted && item.status === "proposed"));
  });
});

test("done cannot be reached without a receipt", async () => {
  await withBusRoot(async (root) => {
    const ready = await createReadyWork(root);
    await assignWorkItem({ work_item_id: ready.work_item_id, agent_id: "codex" }, root);
    const started = await startRun({ work_item_id: ready.work_item_id, actor: "codex" }, root);
    await assert.rejects(
      () => transitionWorkItem({ work_item_id: ready.work_item_id, status: "done", actor: "codex" }, root),
      /completion receipt/,
    );
    assert.equal((await getWorkItem({ work_item_id: ready.work_item_id }, root)).status, "in_progress");
    assert.equal(started.run.agent_id, "codex");
  });
});

test("an unrelated agent cannot control another agent's run", async () => {
  await withBusRoot(async (root) => {
    const ready = await createReadyWork(root);
    await assignWorkItem({ work_item_id: ready.work_item_id, agent_id: "codex" }, root);
    await assert.rejects(
      () => startRun({ work_item_id: ready.work_item_id, actor: "cursor" }, root),
      /assigned agent, human owner/,
    );
  });
});

test("work item list filters and event history remain separate from bus threads", async () => {
  await withBusRoot(async (root) => {
    const first = await createReadyWork(root, { project: "agent-bus" });
    const second = await createWorkItem(
      { title: "Other", objective: "Remain proposed.", source_ref: "T999", project: "other" },
      root,
    );
    await assignWorkItem({ work_item_id: first.work_item_id, agent_id: "cursor" }, root);

    assert.equal((await listWorkItems({ status: "proposed" }, root)).length, 1);
    assert.equal((await listWorkItems({ agent_id: "cursor" }, root))[0].work_item_id, first.work_item_id);
    assert.equal((await listWorkItems({ project: "other" }, root))[0].work_item_id, second.work_item_id);
    const events = await listWorkItemEvents({ work_item_id: first.work_item_id }, root);
    assert.deepEqual(events.map((event) => event.type), ["work_item_created", "status_changed", "work_item_assigned"]);
  });
});
