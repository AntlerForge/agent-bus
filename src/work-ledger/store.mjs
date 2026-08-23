import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { makeId, nowIso } from "../ids.mjs";
import { writeFileAtomic } from "../io.mjs";
import { parseMarkdownWithFrontmatter, stringifyMarkdownWithFrontmatter } from "../markdown.mjs";
import { ensureBusLayout } from "../paths.mjs";
import { findDuplicateIntent } from "./intent.mjs";
import { TRUSTED_POLICIES, trustedPolicyAllowsLedger } from "../trusted-policies.mjs";

export const WORK_STATUSES = ["proposed", "ready", "in_progress", "blocked", "review", "done", "canceled"];
export const RUN_STATUSES = [
  "queued",
  "dispatched",
  "acknowledged",
  "running",
  "waiting_input",
  "blocked",
  "submitted",
  "failed",
  "completed",
];
export const REVIEW_POLICIES = ["none", "human", "independent_agent"];
export const OWNER_DECISIONS = ["approve", "assign", "approve_and_assign", "cancel", "review_approve"];

const ALLOWED_TRANSITIONS = {
  proposed: new Set(["ready", "canceled"]),
  ready: new Set(["in_progress", "canceled"]),
  in_progress: new Set(["blocked", "review", "done", "canceled"]),
  blocked: new Set(["in_progress", "canceled"]),
  review: new Set(["in_progress", "done", "canceled"]),
  done: new Set(),
  canceled: new Set(),
};

const locks = new Map();

async function withItemLock(workItemId, operation) {
  const previous = locks.get(workItemId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(workItemId, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(workItemId) === queued) {
      locks.delete(workItemId);
    }
  }
}

function itemPaths(paths, workItemId) {
  const directory = path.join(paths.workItems, workItemId);
  return {
    directory,
    item: path.join(directory, "work-item.md"),
    events: path.join(directory, "events.jsonl"),
    receipt: path.join(directory, "receipt.md"),
  };
}

function cleanText(value, field) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error(`${field} is required`);
  }
  return text;
}

function workItemBody(item) {
  return `# ${item.title}\n\n${item.objective.trim()}\n`;
}

async function readStoredWorkItem(workItemId, root) {
  const paths = await ensureBusLayout(root);
  const files = itemPaths(paths, workItemId);
  try {
    const raw = await readFile(files.item, "utf8");
    const { data, body } = parseMarkdownWithFrontmatter(raw);
    const objective = body.trimStart().replace(/^#[^\n]*\n+/, "").trim();
    return { ...data, objective, files };
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Work item not found: ${workItemId}`);
    }
    throw error;
  }
}

async function writeStoredWorkItem(item) {
  const { files, objective, ...data } = item;
  await writeFileAtomic(files.item, stringifyMarkdownWithFrontmatter(data, workItemBody(item)));
}

async function appendEvent(files, event) {
  await appendFile(files.events, `${JSON.stringify(event)}\n`, "utf8");
}

function eventRecord(workItemId, type, actor, details = {}) {
  return {
    event_id: makeId("event"),
    work_item_id: workItemId,
    type,
    actor: cleanText(actor, "actor"),
    created_at: nowIso(),
    details,
  };
}

function publicWorkItem(item) {
  const { files, ...record } = item;
  return {
    ...record,
    paths: {
      item: files.item,
      events: files.events,
      receipt: record.receipt_ref ? files.receipt : null,
    },
  };
}

function assertTransition(item, nextStatus, actor) {
  if (!WORK_STATUSES.includes(nextStatus)) {
    throw new Error(`Unsupported work status: ${nextStatus}`);
  }
  if (!ALLOWED_TRANSITIONS[item.status]?.has(nextStatus)) {
    throw new Error(`Cannot transition work item from ${item.status} to ${nextStatus}`);
  }
  if (item.status === "proposed" && nextStatus === "ready") {
    const trusted = actor === item.human_owner || actor.startsWith("policy:");
    if (!trusted) {
      throw new Error("A proposal can only be promoted by its human owner or an explicit policy");
    }
  }
  if (nextStatus === "in_progress" && !item.current_assignment) {
    throw new Error("A work item must be assigned before it can enter in_progress");
  }
  if (nextStatus === "done") {
    if (!item.receipt_ref) {
      throw new Error("A completion receipt is required before a work item can enter done");
    }
    if (item.review_policy !== "none" && item.review_status !== "approved") {
      throw new Error("The configured review gate must approve the work before it can enter done");
    }
  }
}

function isWorkActorAuthorized(item, actor) {
  return actor === item.human_owner || actor === item.current_assignment?.agent_id || actor.startsWith("policy:");
}

function quoteAuthorizesSelfProposal(item, relayingRole, quote, decisionScope) {
  if (item.proposed_by !== relayingRole) return true;
  const normalized = String(quote).toLowerCase().replace(/\s+/g, " ");
  if (decisionScope === "named_item") {
    return normalized.includes(item.work_item_id.toLowerCase())
      || normalized.includes(item.title.toLowerCase());
  }
  return decisionScope === "blanket"
    && /(all approved|everything.{0,40}(approved|actioned)|make (it|everything) (happen|so)|action everything)/i.test(normalized);
}

function buildAssignment(item, { agent_id, assigned_by, budget_tokens }) {
  const assignment = {
    assignment_id: makeId("assignment"),
    agent_id: cleanText(agent_id, "agent_id"),
    assigned_by: cleanText(assigned_by, "assigned_by"),
    assigned_at: nowIso(),
    budget_tokens: budget_tokens === null || budget_tokens === "" || budget_tokens === undefined
      ? item.budget_tokens
      : Number(budget_tokens),
  };
  if (assignment.budget_tokens !== null
    && (!Number.isFinite(assignment.budget_tokens) || assignment.budget_tokens < 0)) {
    throw new Error("budget_tokens must be a non-negative number or null");
  }
  return assignment;
}

async function applyAssignment(item, assignment) {
  item.assignments.push(assignment);
  item.current_assignment = assignment;
  item.updated_at = assignment.assigned_at;
  await appendEvent(item.files, eventRecord(item.work_item_id, "work_item_assigned", assignment.assigned_by, assignment));
}

async function applyTransition(item, nextStatus, actor, reason) {
  assertTransition(item, nextStatus, actor);
  const previous = item.status;
  item.status = nextStatus;
  item.updated_at = nowIso();
  await appendEvent(item.files, eventRecord(item.work_item_id, "status_changed", actor, {
    from: previous,
    to: nextStatus,
    reason: String(reason || "").trim() || null,
  }));
}

export async function createWorkItem(
  {
    title,
    objective,
    human_owner = "tony",
    proposed_by = "tony",
    source_ref,
    context_ref = null,
    project = null,
    priority = "normal",
    budget_tokens = null,
    review_policy = "none",
    acceptance_criteria = [],
    tags = [],
    duplicate_override = false,
  },
  root,
) {
  const normalizedReviewPolicy = String(review_policy || "none");
  if (!REVIEW_POLICIES.includes(normalizedReviewPolicy)) {
    throw new Error(`Unsupported review policy: ${review_policy}`);
  }
  const parsedBudget = budget_tokens === null || budget_tokens === undefined || budget_tokens === ""
    ? null
    : Number(budget_tokens);
  if (parsedBudget !== null && (!Number.isFinite(parsedBudget) || parsedBudget < 0)) {
    throw new Error("budget_tokens must be a non-negative number or null");
  }

  const paths = await ensureBusLayout(root);
  const existingItems = await listWorkItems({}, root);
  const intent = findDuplicateIntent({ title, objective }, existingItems);
  const workItemId = makeId("work");
  const files = itemPaths(paths, workItemId);
  await mkdir(files.directory, { recursive: false });
  const createdAt = nowIso();
  const item = {
    files,
    schema_version: 1,
    work_item_id: workItemId,
    title: cleanText(title, "title"),
    objective: cleanText(objective, "objective"),
    status: intent.duplicate && !duplicate_override ? "canceled" : "proposed",
    human_owner: cleanText(human_owner, "human_owner"),
    proposed_by: cleanText(proposed_by, "proposed_by"),
    source_ref: cleanText(source_ref, "source_ref"),
    context_ref: context_ref ? String(context_ref).trim() : null,
    project: project ? String(project).trim() : null,
    priority: String(priority || "normal").trim(),
    budget_tokens: parsedBudget,
    review_policy: normalizedReviewPolicy,
    review_status: normalizedReviewPolicy === "none" ? "not_required" : "pending",
    acceptance_criteria: Array.isArray(acceptance_criteria) ? acceptance_criteria.map(String) : [],
    tags: Array.isArray(tags) ? tags.map(String) : [],
    assignments: [],
    current_assignment: null,
    runs: [],
    reviews: [],
    receipt_ref: null,
    intent_guard: {
      signature: intent.signature,
      accepted: !intent.duplicate || Boolean(duplicate_override),
      duplicate_of: intent.duplicate?.work_item_id || null,
      similarity: intent.duplicate?.score ?? null,
      override: Boolean(duplicate_override),
    },
    created_at: createdAt,
    updated_at: createdAt,
  };
  await writeStoredWorkItem(item);
  await appendEvent(files, eventRecord(workItemId, "work_item_created", item.proposed_by, {
    status: item.status,
    source_ref: item.source_ref,
    intent_guard: item.intent_guard,
  }));
  return publicWorkItem(item);
}

export async function getWorkItem({ work_item_id }, root) {
  return publicWorkItem(await readStoredWorkItem(cleanText(work_item_id, "work_item_id"), root));
}

export async function listWorkItems({ status, agent_id, project } = {}, root) {
  const paths = await ensureBusLayout(root);
  const entries = await readdir(paths.workItems, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const item = await readStoredWorkItem(entry.name, root);
      if (status && item.status !== status) continue;
      if (agent_id && item.current_assignment?.agent_id !== agent_id) continue;
      if (project && item.project !== project) continue;
      items.push(publicWorkItem(item));
    } catch (error) {
      if (!String(error.message).startsWith("Work item not found:")) throw error;
    }
  }
  items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return items;
}

export async function getWorkItemReceipt({ work_item_id }, root) {
  const item = await readStoredWorkItem(cleanText(work_item_id, "work_item_id"), root);
  if (!item.receipt_ref) return null;
  try {
    const { data, body } = parseMarkdownWithFrontmatter(await readFile(item.files.receipt, "utf8"));
    return { ...data, summary: body.trim().replace(/^#\s*Completion receipt\s*/i, "").trim() };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function listWorkItemEvents({ work_item_id }, root) {
  const item = await readStoredWorkItem(cleanText(work_item_id, "work_item_id"), root);
  try {
    const raw = await readFile(item.files.events, "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function transitionWorkItem({ work_item_id, status, actor = "tony", reason = null }, root) {
  const id = cleanText(work_item_id, "work_item_id");
  return withItemLock(id, async () => {
    const item = await readStoredWorkItem(id, root);
    await applyTransition(item, status, cleanText(actor, "actor"), reason);
    await writeStoredWorkItem(item);
    return publicWorkItem(item);
  });
}

export async function assignWorkItem(
  { work_item_id, agent_id, assigned_by = "tony", budget_tokens = null },
  root,
) {
  const id = cleanText(work_item_id, "work_item_id");
  return withItemLock(id, async () => {
    const item = await readStoredWorkItem(id, root);
    if (!["ready", "blocked"].includes(item.status)) {
      throw new Error("Only ready or blocked work can be assigned");
    }
    const assignment = buildAssignment(item, { agent_id, assigned_by, budget_tokens });
    await applyAssignment(item, assignment);
    await writeStoredWorkItem(item);
    return publicWorkItem(item);
  });
}

export async function recordOwnerDecision(
  {
    work_item_id,
    decision,
    owner_quote,
    where_said,
    relaying_role,
    policy_id,
    decision_scope = "named_item",
    agent_id = null,
    budget_tokens = null,
  },
  root,
  { trustedPolicies = TRUSTED_POLICIES } = {},
) {
  const id = cleanText(work_item_id, "work_item_id");
  const normalizedDecision = cleanText(decision, "decision");
  if (!OWNER_DECISIONS.includes(normalizedDecision)) throw new Error(`Unsupported owner decision: ${normalizedDecision}`);
  const relay = cleanText(relaying_role, "relaying_role");
  const policyId = cleanText(policy_id, "policy_id");
  const quote = cleanText(owner_quote, "owner_quote");
  const source = cleanText(where_said, "where_said");
  if (!["named_item", "blanket"].includes(decision_scope)) throw new Error("decision_scope must be named_item or blanket");
  if (!trustedPolicyAllowsLedger({ relaying_role: relay, decision: normalizedDecision }, policyId, trustedPolicies)) {
    throw new Error("The named trusted policy does not grant this role the requested ledger scope");
  }

  return withItemLock(id, async () => {
    const item = await readStoredWorkItem(id, root);
    if (!quoteAuthorizesSelfProposal(item, relay, quote, decision_scope)) {
      throw new Error("A relay role cannot advance its own proposal without a named-item or unambiguous blanket owner quote");
    }

    if (["approve", "approve_and_assign"].includes(normalizedDecision)) {
      assertTransition(item, "ready", `policy:${policyId}`);
    } else if (normalizedDecision === "assign" && !["ready", "blocked"].includes(item.status)) {
      throw new Error("Only ready or blocked work can be assigned");
    } else if (normalizedDecision === "cancel") {
      assertTransition(item, "canceled", `policy:${policyId}`);
    } else if (normalizedDecision === "review_approve") {
      if (item.status !== "review") throw new Error("Work item is not awaiting review");
      assertTransition(item, "done", `policy:${policyId}`);
    }
    const assignment = ["assign", "approve_and_assign"].includes(normalizedDecision)
      ? buildAssignment(item, { agent_id, assigned_by: `policy:${policyId}`, budget_tokens })
      : null;

    const recordedAt = nowIso();
    await appendEvent(item.files, eventRecord(id, "owner_decision_relayed", `policy:${policyId}`, {
      decision: normalizedDecision,
      owner: item.human_owner,
      owner_quote: quote,
      where_said: source,
      relaying_role: relay,
      policy_id: policyId,
      decision_scope,
      recorded_at: recordedAt,
    }));
    if (["approve", "approve_and_assign"].includes(normalizedDecision)) {
      await applyTransition(item, "ready", `policy:${policyId}`, `Owner decision relayed by ${relay}`);
    }
    if (assignment) await applyAssignment(item, assignment);
    if (normalizedDecision === "cancel") {
      await applyTransition(item, "canceled", `policy:${policyId}`, `Owner decision relayed by ${relay}`);
    }
    if (normalizedDecision === "review_approve") {
      const review = {
        review_id: makeId("review"), reviewer: `policy:${policyId}`, decision: "approved",
        summary: `Owner approval relayed by ${relay}`, evidence: [source], created_at: recordedAt,
      };
      item.reviews.push(review);
      item.review_status = "approved";
      await appendEvent(item.files, eventRecord(id, "review_recorded", review.reviewer, review));
      await applyTransition(item, "done", review.reviewer, review.summary);
    }
    item.updated_at = recordedAt;
    await writeStoredWorkItem(item);
    return publicWorkItem(item);
  });
}

export async function startRun(
  { work_item_id, actor, provider = null, provider_session_ref = null, thread_id = null },
  root,
) {
  const id = cleanText(work_item_id, "work_item_id");
  return withItemLock(id, async () => {
    const item = await readStoredWorkItem(id, root);
    if (!item.current_assignment) {
      throw new Error("Assign the work item before starting a run");
    }
    const runActor = cleanText(actor || item.current_assignment.agent_id, "actor");
    if (!isWorkActorAuthorized(item, runActor)) {
      throw new Error("Only the assigned agent, human owner, or an explicit policy can start this run");
    }
    if (!["ready", "blocked", "in_progress"].includes(item.status)) {
      throw new Error(`Cannot start a run while work item is ${item.status}`);
    }
    const run = {
      run_id: makeId("run"),
      assignment_id: item.current_assignment.assignment_id,
      agent_id: item.current_assignment.agent_id,
      provider: provider ? String(provider).trim() : null,
      provider_session_ref: provider_session_ref ? String(provider_session_ref).trim() : null,
      thread_id: thread_id ? String(thread_id).trim() : null,
      status: "running",
      started_at: nowIso(),
      updated_at: nowIso(),
      usage: { input_tokens: null, output_tokens: null, total_tokens: null, estimated_cost: null },
    };
    item.runs.push(run);
    if (item.status !== "in_progress") {
      await applyTransition(item, "in_progress", runActor, "Agent run started");
    }
    item.updated_at = run.updated_at;
    await appendEvent(item.files, eventRecord(id, "run_started", runActor, run));
    await writeStoredWorkItem(item);
    return { work_item: publicWorkItem(item), run };
  });
}

export async function updateRun(
  { work_item_id, run_id, status, actor, input_tokens, output_tokens, estimated_cost, reason = null },
  root,
) {
  const id = cleanText(work_item_id, "work_item_id");
  return withItemLock(id, async () => {
    const item = await readStoredWorkItem(id, root);
    const run = item.runs.find((candidate) => candidate.run_id === run_id);
    if (!run) throw new Error(`Run not found: ${run_id}`);
    const runActor = cleanText(actor || run.agent_id, "actor");
    if (!isWorkActorAuthorized(item, runActor)) {
      throw new Error("Only the assigned agent, human owner, or an explicit policy can update this run");
    }
    if (!RUN_STATUSES.includes(status)) throw new Error(`Unsupported run status: ${status}`);
    run.status = status;
    run.updated_at = nowIso();
    const parseUsage = (value, previous) => value === undefined ? previous : value === null ? null : Number(value);
    const parsedInput = parseUsage(input_tokens, run.usage.input_tokens);
    const parsedOutput = parseUsage(output_tokens, run.usage.output_tokens);
    if (![parsedInput, parsedOutput].every((value) => value === null || (Number.isFinite(value) && value >= 0))) {
      throw new Error("Token usage must be non-negative numbers or null");
    }
    run.usage = {
      input_tokens: parsedInput,
      output_tokens: parsedOutput,
      total_tokens: parsedInput === null || parsedOutput === null ? null : parsedInput + parsedOutput,
      estimated_cost: estimated_cost === undefined ? run.usage.estimated_cost : estimated_cost === null ? null : Number(estimated_cost),
    };
    if (run.usage.estimated_cost !== null && !Number.isFinite(run.usage.estimated_cost)) {
      throw new Error("estimated_cost must be numeric or null");
    }
    if (["blocked", "failed"].includes(status) && item.status === "in_progress") {
      await applyTransition(item, "blocked", runActor, reason || `Run ${status}`);
    }
    item.updated_at = run.updated_at;
    await appendEvent(item.files, eventRecord(id, "run_updated", runActor, {
      run_id: run.run_id,
      status,
      usage: run.usage,
      reason,
    }));
    await writeStoredWorkItem(item);
    return { work_item: publicWorkItem(item), run };
  });
}

export async function submitReceipt(
  {
    work_item_id,
    submitted_by,
    outcome,
    summary,
    evidence = [],
    deliverables = [],
    limitations = [],
    usage = null,
  },
  root,
) {
  const id = cleanText(work_item_id, "work_item_id");
  return withItemLock(id, async () => {
    const item = await readStoredWorkItem(id, root);
    if (!["in_progress", "blocked", "review"].includes(item.status)) {
      throw new Error(`Cannot submit a receipt while work item is ${item.status}`);
    }
    const receiptActor = cleanText(submitted_by, "submitted_by");
    if (!isWorkActorAuthorized(item, receiptActor)) {
      throw new Error("Only the assigned agent, human owner, or an explicit policy can submit this receipt");
    }
    const receipt = {
      schema_version: 2,
      receipt_id: makeId("receipt"),
      work_item_id: id,
      submitted_by: receiptActor,
      outcome: cleanText(outcome, "outcome"),
      evidence: Array.isArray(evidence) ? evidence : [],
      deliverables: Array.isArray(deliverables) ? deliverables.map(String) : [],
      limitations: Array.isArray(limitations) ? limitations.map(String) : [],
      usage,
      created_at: nowIso(),
    };
    if (!receipt.evidence.length || receipt.evidence.some((entry) => !entry || typeof entry !== "object"
      || !String(entry.target_state || "").trim() || !String(entry.location || "").trim()
      || !String(entry.verify || "").trim())) {
      throw new Error("Receipt evidence must include target_state, location, and verify for every claim");
    }
    const receiptBody = `# Completion receipt\n\n${cleanText(summary, "summary")}\n`;
    await writeFileAtomic(item.files.receipt, stringifyMarkdownWithFrontmatter(receipt, receiptBody));
    item.receipt_ref = item.files.receipt;
    item.updated_at = receipt.created_at;
    await appendEvent(item.files, eventRecord(id, "receipt_submitted", receipt.submitted_by, {
      receipt_id: receipt.receipt_id,
      outcome: receipt.outcome,
    }));
    const nextStatus = item.review_policy === "none" ? "done" : "review";
    if (item.status === "blocked") {
      await applyTransition(item, "in_progress", receipt.submitted_by, "Receipt submitted after blocked run");
    }
    if (item.status !== nextStatus) {
      await applyTransition(item, nextStatus, receipt.submitted_by, "Completion receipt submitted");
    }
    await writeStoredWorkItem(item);
    return { work_item: publicWorkItem(item), receipt };
  });
}

export async function reviewWorkItem(
  { work_item_id, reviewer, decision, summary, evidence = [] },
  root,
) {
  const id = cleanText(work_item_id, "work_item_id");
  return withItemLock(id, async () => {
    const item = await readStoredWorkItem(id, root);
    if (item.status !== "review") throw new Error("Work item is not awaiting review");
    const normalizedDecision = String(decision || "");
    if (!["approved", "changes_requested"].includes(normalizedDecision)) {
      throw new Error("Review decision must be approved or changes_requested");
    }
    const reviewerId = cleanText(reviewer, "reviewer");
    if (item.review_policy === "independent_agent" && reviewerId === item.current_assignment?.agent_id) {
      throw new Error("Independent review must be performed by a different agent");
    }
    const review = {
      review_id: makeId("review"),
      reviewer: reviewerId,
      decision: normalizedDecision,
      summary: cleanText(summary, "summary"),
      evidence: Array.isArray(evidence) ? evidence.map(String) : [],
      created_at: nowIso(),
    };
    item.reviews.push(review);
    item.review_status = normalizedDecision;
    await appendEvent(item.files, eventRecord(id, "review_recorded", reviewerId, review));
    await applyTransition(
      item,
      normalizedDecision === "approved" ? "done" : "in_progress",
      reviewerId,
      review.summary,
    );
    await writeStoredWorkItem(item);
    return { work_item: publicWorkItem(item), review };
  });
}

export async function getUsageSummary(root) {
  const items = await listWorkItems({}, root);
  const byAgent = {};
  let totalTokens = 0;
  let usageKnown = true;
  let estimatedCost = 0;
  let costKnown = true;
  for (const item of items) {
    for (const run of item.runs || []) {
      const usage = run.usage || {};
      const agent = run.agent_id || "unassigned";
      byAgent[agent] ||= { input_tokens: 0, output_tokens: 0, total_tokens: 0, usage_known: true, unknown_runs: 0, estimated_cost: 0, cost_known: true };
      if (usage.total_tokens === null || usage.total_tokens === undefined) {
        byAgent[agent].usage_known = false;
        byAgent[agent].unknown_runs += 1;
        usageKnown = false;
      } else {
        byAgent[agent].input_tokens += Number(usage.input_tokens);
        byAgent[agent].output_tokens += Number(usage.output_tokens);
        byAgent[agent].total_tokens += Number(usage.total_tokens);
        totalTokens += Number(usage.total_tokens);
      }
      if (usage.estimated_cost === null || usage.estimated_cost === undefined) {
        byAgent[agent].cost_known = false;
        costKnown = false;
      } else {
        byAgent[agent].estimated_cost += Number(usage.estimated_cost);
        estimatedCost += Number(usage.estimated_cost);
      }
    }
  }
  return {
    total_tokens: usageKnown ? totalTokens : null,
    usage_known: usageKnown,
    estimated_cost: costKnown ? estimatedCost : null,
    cost_known: costKnown,
    by_agent: byAgent,
  };
}
