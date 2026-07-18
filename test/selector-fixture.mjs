import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeSelectorFixture(directory, overrides = {}) {
  await mkdir(directory, { recursive: true });
  const documents = {
    "models.json": {
      schema_version: "3.0",
      last_verified: "2026-07-10",
      next_review: "2099-01-01",
      task_categories: ["creative_writing"],
      models: [
        { model_id: "writer", display_name: "Writer", provider: "A", lifecycle: "active", evidence_refs: ["ev"], provisional_categories: [], scores: { creative_writing: 9 } },
        { model_id: "reviewer", display_name: "Reviewer", provider: "B", lifecycle: "active", evidence_refs: ["ev"], provisional_categories: [], scores: { creative_writing: 8 } },
      ],
    },
    "surfaces.json": {
      schema_version: "3.0",
      last_verified: "2026-07-10",
      surfaces: [
        { surface_id: "surface-a", display_name: "Surface A", access: "available", independence_group: "a", models: ["writer"], evidence_refs: ["ev"] },
        { surface_id: "surface-b", display_name: "Surface B", access: "available", independence_group: "b", models: ["reviewer"], evidence_refs: ["ev"] },
      ],
    },
    "evidence.json": {
      schema_version: "3.0",
      last_verified: "2026-07-10",
      evidence: [{ evidence_id: "ev", publisher: "Fixture", source_type: "test", published: "2026-07-10", url: null, supports: ["writer", "reviewer"], confidence: "high" }],
    },
    "routing.json": {
      schema_version: "3.0",
      status: "current",
      last_verified: "2026-07-10",
      next_review: "2099-01-01",
      policy: { advisory_only: true, proposal_requires_approval: true },
      routes: [{ route_id: "review", title: "Review", task_categories: ["creative_writing"], panel: [{ model_id: "writer", surface_id: "surface-a" }, { model_id: "reviewer", surface_id: "surface-b" }] }],
      workflow_templates: [{
        template_id: "panel",
        title: "Panel",
        route_id: "review",
        work_items: [
          { role: "writer", title: "Write {{subject}}", objective: "Prepare {{subject}}", recommended_model_id: "writer", recommended_surface_id: "surface-a", review_policy: "human", acceptance_criteria: ["Freeze {{subject}}"] },
          { role: "reviewer", title: "Review {{subject}}", objective: "Review {{subject}} independently", recommended_model_id: "reviewer", recommended_surface_id: "surface-b", review_policy: "human", acceptance_criteria: ["Do not rewrite"] },
        ],
      }],
    },
    ...overrides,
  };
  for (const [filename, document] of Object.entries(documents)) {
    await writeFile(path.join(directory, filename), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
  return directory;
}
