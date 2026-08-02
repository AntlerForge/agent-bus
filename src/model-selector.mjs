import { readFile } from "node:fs/promises";
import path from "node:path";

const FILES = ["models.json", "surfaces.json", "evidence.json", "routing.json"];
const HARNESS_CAPABILITY_LEVELS = new Set(["absent", "limited", "available", "strong", "distinctive", "unknown"]);

function unavailable(reason, selectorPath = null) {
  return {
    status: "unavailable",
    selector_path: selectorPath,
    schema_version: null,
    warnings: [reason],
    models: [],
    surfaces: [],
    evidence: [],
    routes: [],
    workflow_templates: [],
    summary: { model_count: 0, harness_count: 0, model_harness_pair_count: 0, available_surface_count: 0, route_count: 0, template_count: 0 },
  };
}

function requireText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function assertUnique(records, key, label) {
  const seen = new Set();
  for (const record of records) {
    const value = requireText(record[key], `${label}.${key}`);
    if (seen.has(value)) throw new Error(`Duplicate ${label} ${key}: ${value}`);
    seen.add(value);
  }
  return seen;
}

function validateReference(ref, known, label) {
  if (!known.has(ref)) throw new Error(`${label} references unknown value: ${ref}`);
}

function validateRouteTarget(target, modelIds, surfaceIds, surfaceModelIds, label) {
  const modelId = requireText(target.model_id, `${label}.model_id`);
  const surfaceId = requireText(target.surface_id, `${label}.surface_id`);
  validateReference(modelId, modelIds, `${label}.model_id`);
  validateReference(surfaceId, surfaceIds, `${label}.surface_id`);
  if (!surfaceModelIds.get(surfaceId)?.has(modelId)) {
    throw new Error(`${label} references unavailable model-harness pair: ${modelId} on ${surfaceId}`);
  }
}

function validateHarnessProfile(surface, evidenceIds, label) {
  const harness = surface.harness;
  if (!harness || typeof harness !== "object") throw new Error(`${label}.harness is required`);
  requireText(harness.kind, `${label}.harness.kind`);
  requireText(harness.execution_location, `${label}.harness.execution_location`);
  const capabilities = harness.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Object.keys(capabilities).length === 0) {
    throw new Error(`${label}.harness.capabilities is required`);
  }
  for (const [capability, level] of Object.entries(capabilities)) {
    if (!HARNESS_CAPABILITY_LEVELS.has(level)) {
      throw new Error(`${label}.harness.capabilities.${capability} has invalid level: ${level}`);
    }
  }
  for (const field of ["strengths", "weaknesses", "best_for"]) {
    if (!Array.isArray(harness[field]) || harness[field].length === 0) {
      throw new Error(`${label}.harness.${field} must be a non-empty array`);
    }
  }
  for (const evidenceRef of harness.evidence_refs || []) validateReference(evidenceRef, evidenceIds, label);
}

function isPast(date, now = new Date()) {
  if (!date) return false;
  const parsed = new Date(`${date}T23:59:59Z`);
  return Number.isFinite(parsed.getTime()) && now.getTime() > parsed.getTime();
}

export async function loadModelSelector(selectorPath = process.env.AGENT_BUS_SELECTOR_PATH || null, { now = new Date() } = {}) {
  if (!selectorPath) return unavailable("AGENT_BUS_SELECTOR_PATH is not configured");
  const directory = path.resolve(selectorPath);
  let documents;
  try {
    documents = Object.fromEntries(await Promise.all(FILES.map(async (filename) => {
      const raw = await readFile(path.join(directory, filename), "utf8");
      return [filename, JSON.parse(raw)];
    })));
  } catch (error) {
    return unavailable(`Could not load selector v3: ${error.message}`, directory);
  }

  const modelsDoc = documents["models.json"];
  const surfacesDoc = documents["surfaces.json"];
  const evidenceDoc = documents["evidence.json"];
  const routingDoc = documents["routing.json"];
  const versions = new Set(FILES.map((filename) => String(documents[filename].schema_version || "")));
  if (versions.size !== 1 || ![...versions][0].startsWith("3.")) {
    throw new Error(`Selector documents must share a 3.x schema version; found ${[...versions].join(", ")}`);
  }

  const models = Array.isArray(modelsDoc.models) ? modelsDoc.models : [];
  const surfaces = Array.isArray(surfacesDoc.surfaces) ? surfacesDoc.surfaces : [];
  const evidence = Array.isArray(evidenceDoc.evidence) ? evidenceDoc.evidence : [];
  const routes = Array.isArray(routingDoc.routes) ? routingDoc.routes : [];
  const workflowTemplates = Array.isArray(routingDoc.workflow_templates) ? routingDoc.workflow_templates : [];
  const categories = new Set(modelsDoc.task_categories || []);
  const modelIds = assertUnique(models, "model_id", "model");
  const surfaceIds = assertUnique(surfaces, "surface_id", "surface");
  const evidenceIds = assertUnique(evidence, "evidence_id", "evidence");
  const schemaVersion = [...versions][0];
  const requiresHarnessProfiles = Number(schemaVersion.split(".")[1] || 0) >= 2;
  const surfaceModelIds = new Map(surfaces.map((surface) => [surface.surface_id, new Set(surface.models || [])]));
  assertUnique(routes, "route_id", "route");
  assertUnique(workflowTemplates, "template_id", "workflow_template");

  for (const model of models) {
    if (requiresHarnessProfiles) requireText(model.independence_group, `model ${model.model_id}.independence_group`);
    for (const category of categories) {
      const score = model.scores?.[category];
      if (!Number.isInteger(score) || score < 1 || score > 10) {
        throw new Error(`Model ${model.model_id} must score ${category} from 1 to 10`);
      }
    }
    for (const evidenceRef of model.evidence_refs || []) validateReference(evidenceRef, evidenceIds, `model ${model.model_id}`);
  }
  for (const surface of surfaces) {
    for (const modelId of surface.models || []) validateReference(modelId, modelIds, `surface ${surface.surface_id}`);
    for (const evidenceRef of surface.evidence_refs || []) validateReference(evidenceRef, evidenceIds, `surface ${surface.surface_id}`);
    if (requiresHarnessProfiles) validateHarnessProfile(surface, evidenceIds, `surface ${surface.surface_id}`);
  }
  for (const route of routes) {
    if (route.primary) validateRouteTarget(route.primary, modelIds, surfaceIds, surfaceModelIds, `route ${route.route_id}.primary`);
    for (const target of route.alternatives || []) validateRouteTarget(target, modelIds, surfaceIds, surfaceModelIds, `route ${route.route_id}.alternative`);
    for (const target of route.panel || []) validateRouteTarget(target, modelIds, surfaceIds, surfaceModelIds, `route ${route.route_id}.panel`);
    for (const category of route.task_categories || []) validateReference(category, categories, `route ${route.route_id}.task_categories`);
  }
  const routeIds = new Set(routes.map((route) => route.route_id));
  for (const template of workflowTemplates) {
    validateReference(template.route_id, routeIds, `workflow_template ${template.template_id}.route_id`);
    for (const item of template.work_items || []) {
      validateReference(item.recommended_model_id, modelIds, `workflow_template ${template.template_id}.model`);
      validateReference(item.recommended_surface_id, surfaceIds, `workflow_template ${template.template_id}.surface`);
    }
  }

  const warnings = [];
  if (isPast(routingDoc.next_review, now) || isPast(modelsDoc.next_review, now)) {
    warnings.push(`Selector review is overdue; next review was ${routingDoc.next_review || modelsDoc.next_review}`);
  }
  for (const route of routes) {
    const targets = [route.primary, ...(route.alternatives || []), ...(route.panel || [])].filter(Boolean);
    for (const target of targets) {
      const surface = surfaces.find((entry) => entry.surface_id === target.surface_id);
      if (surface?.access !== "available") warnings.push(`${route.route_id} includes unavailable surface ${target.surface_id}`);
    }
    if (route.panel) {
      const groups = new Set(route.panel.map((target) => models.find((model) => model.model_id === target.model_id)?.independence_group));
      if (groups.size !== route.panel.length) warnings.push(`${route.route_id} panel does not use distinct independence groups`);
    }
  }

  const status = warnings.some((warning) => warning.startsWith("Selector review is overdue")) ? "stale" : "current";
  return {
    status,
    selector_path: directory,
    schema_version: schemaVersion,
    last_verified: routingDoc.last_verified,
    next_review: routingDoc.next_review,
    policy: routingDoc.policy || {},
    warnings,
    models,
    surfaces,
    evidence,
    routes,
    workflow_templates: workflowTemplates,
    summary: {
      model_count: models.length,
      harness_count: surfaces.length,
      model_harness_pair_count: surfaces.reduce((count, surface) => count + (surface.models || []).length, 0),
      available_surface_count: surfaces.filter((surface) => surface.access === "available").length,
      route_count: routes.length,
      template_count: workflowTemplates.length,
    },
  };
}

export function getSelectorRoute(selector, { route_id = null, task_category = null } = {}) {
  if (selector.status === "unavailable") return null;
  if (route_id) return selector.routes.find((route) => route.route_id === route_id) || null;
  if (task_category) return selector.routes.find((route) => route.task_categories?.includes(task_category)) || null;
  return null;
}

function interpolate(value, subject) {
  return String(value || "").replaceAll("{{subject}}", subject);
}

export function buildWorkflowProposals(selector, templateId, {
  subject,
  source_ref,
  context_ref = null,
  project = null,
  human_owner = "tony",
  proposed_by = "tony",
} = {}) {
  if (selector.status === "unavailable") throw new Error("Model selector is unavailable");
  const template = selector.workflow_templates.find((entry) => entry.template_id === templateId);
  if (!template) throw new Error(`Unknown selector workflow template: ${templateId}`);
  const cleanSubject = requireText(subject, "subject");
  const sourceRef = requireText(source_ref, "source_ref");
  const workflowRef = `${templateId}:${Date.now()}`;
  return {
    template_id: templateId,
    workflow_ref: workflowRef,
    route_id: template.route_id,
    proposals: template.work_items.map((item) => ({
      title: interpolate(item.title, cleanSubject),
      objective: interpolate(item.objective, cleanSubject),
      human_owner,
      proposed_by,
      source_ref: sourceRef,
      context_ref,
      project,
      review_policy: item.review_policy || "human",
      acceptance_criteria: (item.acceptance_criteria || []).map((criterion) => interpolate(criterion, cleanSubject)),
      tags: [
        `workflow:${workflowRef}`,
        `template:${templateId}`,
        `role:${item.role}`,
        `recommended-model:${item.recommended_model_id}`,
        `recommended-surface:${item.recommended_surface_id}`,
      ],
    })),
  };
}
