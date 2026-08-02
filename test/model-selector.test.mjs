import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildWorkflowProposals, getSelectorRoute, loadModelSelector } from "../src/model-selector.mjs";
import { writeSelectorFixture } from "./selector-fixture.mjs";

async function withFixture(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-selector-test-"));
  try {
    await writeSelectorFixture(directory);
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("selector validates and exposes current advisory routes", async () => {
  await withFixture(async (directory) => {
    const selector = await loadModelSelector(directory, { now: new Date("2026-07-10T12:00:00Z") });
    assert.equal(selector.status, "current");
    assert.equal(selector.summary.model_count, 2);
    assert.equal(selector.summary.harness_count, 2);
    assert.equal(selector.summary.model_harness_pair_count, 2);
    assert.equal(selector.summary.available_surface_count, 2);
    assert.equal(getSelectorRoute(selector, { task_category: "creative_writing" }).route_id, "review");
    assert.deepEqual(selector.warnings, []);
  });
});

test("selector rejects a route whose model is unavailable in the selected harness", async () => {
  await withFixture(async (directory) => {
    const filename = path.join(directory, "routing.json");
    const document = JSON.parse(await readFile(filename, "utf8"));
    document.routes[0].panel[0].surface_id = "surface-b";
    await writeFile(filename, JSON.stringify(document), "utf8");
    await assert.rejects(() => loadModelSelector(directory), /unavailable model-harness pair/);
  });
});

test("independent panels are checked by model lineage rather than harness", async () => {
  await withFixture(async (directory) => {
    const modelsFilename = path.join(directory, "models.json");
    const modelsDocument = JSON.parse(await readFile(modelsFilename, "utf8"));
    modelsDocument.models[1].independence_group = "lineage-a";
    await writeFile(modelsFilename, JSON.stringify(modelsDocument), "utf8");
    const selector = await loadModelSelector(directory);
    assert.match(selector.warnings[0], /distinct independence groups/);
  });
});

test("selector rejects unknown model references", async () => {
  await withFixture(async (directory) => {
    const filename = path.join(directory, "surfaces.json");
    const document = JSON.parse(await readFile(filename, "utf8"));
    document.surfaces[0].models.push("missing-model");
    await writeFile(filename, JSON.stringify(document), "utf8");
    await assert.rejects(() => loadModelSelector(directory), /unknown value: missing-model/);
  });
});

test("selector reports an overdue review as stale", async () => {
  await withFixture(async (directory) => {
    const filename = path.join(directory, "routing.json");
    const document = JSON.parse(await readFile(filename, "utf8"));
    document.next_review = "2026-07-01";
    await writeFile(filename, JSON.stringify(document), "utf8");
    const selector = await loadModelSelector(directory, { now: new Date("2026-07-10T12:00:00Z") });
    assert.equal(selector.status, "stale");
    assert.match(selector.warnings[0], /review is overdue/);
  });
});

test("workflow templates only build proposed-work payloads", async () => {
  await withFixture(async (directory) => {
    const selector = await loadModelSelector(directory);
    const workflow = buildWorkflowProposals(selector, "panel", { subject: "Chapter 38", source_ref: "book:chapter-38", proposed_by: "codex" });
    assert.equal(workflow.proposals.length, 2);
    assert.equal(workflow.proposals[0].title, "Write Chapter 38");
    assert.equal(workflow.proposals[0].review_policy, "human");
    assert.ok(workflow.proposals[1].tags.includes("recommended-model:reviewer"));
    assert.equal(workflow.proposals[0].status, undefined);
  });
});
