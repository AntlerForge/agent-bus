#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listAgents, registerAgent } from "./agents.mjs";
import { readArtifactManifest } from "./artifacts.mjs";
import {
  ackMessage,
  getThread,
  listThreads,
  markRead,
  readInbox,
  replyMessage,
  sendMessage,
  updateThreadStatus,
} from "./mailbox.mjs";
import { ensureBusLayout, getBusRoot } from "./paths.mjs";
import {
  createWorkItem,
  getWorkItem,
  listWorkItemEvents,
  listWorkItems,
  reviewWorkItem,
  startRun,
  submitReceipt,
  updateRun,
} from "./work-ledger/store.mjs";
import { createRemoteWorkLedger } from "./work-ledger/remote.mjs";
import { createRemoteBus } from "./remote-bus.mjs";
import { buildWorkflowProposals, loadModelSelector } from "./model-selector.mjs";
import { createRemoteModelSelector } from "./model-selector-remote.mjs";

function toolResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

function registerTool(server, name, description, inputSchema, handler) {
  server.registerTool(
    name,
    {
      title: name,
      description,
      inputSchema,
    },
    async (args) => {
      try {
        return toolResult(await handler(args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

const root = getBusRoot();
const remoteWorkLedgerUrl = process.env.AGENT_BUS_CONTROL_PLANE_URL || null;
if (!remoteWorkLedgerUrl) await ensureBusLayout(root);
const remoteWorkLedger = remoteWorkLedgerUrl
  ? createRemoteWorkLedger(remoteWorkLedgerUrl, { writeToken: process.env.AGENT_BUS_WRITE_TOKEN || null })
  : null;
const remoteBus = remoteWorkLedgerUrl
  ? createRemoteBus(remoteWorkLedgerUrl, { writeToken: process.env.AGENT_BUS_WRITE_TOKEN || null })
  : null;
const remoteModelSelector = remoteWorkLedgerUrl
  ? createRemoteModelSelector(remoteWorkLedgerUrl, { writeToken: process.env.AGENT_BUS_WRITE_TOKEN || null })
  : null;

const workLedger = {
  create: (args) => remoteWorkLedger ? remoteWorkLedger.createWorkItem(args) : createWorkItem(args, root),
  list: (args) => remoteWorkLedger ? remoteWorkLedger.listWorkItems(args) : listWorkItems(args, root),
  get: async (args) => remoteWorkLedger
    ? remoteWorkLedger.getWorkItem(args)
    : { item: await getWorkItem(args, root), events: await listWorkItemEvents(args, root) },
  startRun: (args) => remoteWorkLedger ? remoteWorkLedger.startRun(args) : startRun(args, root),
  updateRun: (args) => remoteWorkLedger ? remoteWorkLedger.updateRun(args) : updateRun(args, root),
  submitReceipt: (args) => remoteWorkLedger ? remoteWorkLedger.submitReceipt(args) : submitReceipt(args, root),
  review: (args) => remoteWorkLedger ? remoteWorkLedger.reviewWorkItem(args) : reviewWorkItem(args, root),
};

const modelSelector = {
  get: () => remoteModelSelector ? remoteModelSelector.get() : loadModelSelector(),
  proposeWorkflow: async (args) => {
    if (remoteModelSelector) return remoteModelSelector.proposeWorkflow(args);
    const selector = await loadModelSelector();
    const { template_id, ...input } = args;
    const workflow = buildWorkflowProposals(selector, template_id, input);
    const created = [];
    for (const proposal of workflow.proposals) created.push(await workLedger.create(proposal));
    return { ...workflow, proposals: undefined, created };
  },
};

const server = new McpServer({
  name: "agent-bus",
  version: "0.1.0",
});

const artifactPaths = z.array(z.string()).optional().default([]);

registerTool(
  server,
  "send_message",
  "Send a Markdown-backed message to another local agent.",
  {
    from: z.string(),
    to: z.string(),
    subject: z.string(),
    body: z.string(),
    thread_id: z.string().optional(),
    priority: z.string().optional().default("normal"),
    ack_required: z.boolean().optional().default(false),
    requires_response: z.boolean().optional().default(false),
    artifact_paths: artifactPaths,
    idempotency_key: z.string().optional(),
  },
  (args) => remoteBus ? remoteBus.sendMessage(args) : sendMessage(args, root),
);

registerTool(
  server,
  "read_inbox",
  "Read messages addressed to an agent.",
  {
    agent: z.string(),
    include_read: z.boolean().optional().default(false),
  },
  (args) => remoteBus ? remoteBus.readInbox(args) : readInbox(args, root),
);

registerTool(
  server,
  "reply",
  "Reply to an existing thread with explicit sender and recipient.",
  {
    from: z.string(),
    to: z.string(),
    thread_id: z.string(),
    body: z.string(),
    priority: z.string().optional().default("normal"),
    ack_required: z.boolean().optional().default(false),
    requires_response: z.boolean().optional().default(false),
    artifact_paths: artifactPaths,
  },
  (args) => remoteBus ? remoteBus.replyMessage(args) : replyMessage(args, root),
);

registerTool(
  server,
  "ack_message",
  "Acknowledge receipt of a message without marking the task complete.",
  {
    message_id: z.string(),
  },
  (args) => remoteBus ? remoteBus.ackMessage(args) : ackMessage(args, root),
);

registerTool(
  server,
  "mark_read",
  "Mark a message as read in place.",
  {
    message_id: z.string(),
  },
  (args) => remoteBus ? remoteBus.markRead(args) : markRead(args, root),
);

registerTool(
  server,
  "update_thread_status",
  "Update thread lifecycle status.",
  {
    thread_id: z.string(),
    status: z.enum([
      "open",
      "acknowledged",
      "in_progress",
      "input_required",
      "blocked",
      "completed",
      "failed",
      "canceled",
      "closed",
    ]),
  },
  (args) => remoteBus ? remoteBus.updateThreadStatus(args) : updateThreadStatus(args, root),
);

registerTool(server, "list_threads", "List known message threads.", {}, () => remoteBus ? remoteBus.listThreads() : listThreads(root));

registerTool(
  server,
  "get_thread",
  "Read one message thread including its transcript.",
  { thread_id: z.string() },
  (args) => remoteBus ? remoteBus.getThread(args) : getThread(args, root),
);

registerTool(
  server,
  "register_agent",
  "Create or update a local agent identity.",
  {
    agent_id: z.string(),
    display_name: z.string().optional(),
    type: z.string().optional(),
    capabilities: z.array(z.string()).optional().default([]),
  },
  (args) => remoteBus ? remoteBus.registerAgent(args) : registerAgent(args, root),
);

registerTool(server, "list_agents", "List known agent identities.", {}, () => remoteBus ? remoteBus.listAgents() : listAgents(root));

registerTool(server, "list_artifacts", "List shared artifact metadata.", {}, () => remoteBus ? remoteBus.listArtifacts() : readArtifactManifest(root));

registerTool(
  server,
  "get_model_selector",
  "Read current advisory model, surface, evidence, routing and workflow-template guidance. Recommendations never dispatch work.",
  {},
  () => modelSelector.get(),
);

registerTool(
  server,
  "propose_routing_workflow",
  "Create unapproved Agent Work Ledger proposals from a selector workflow template. The proposals still require owner approval and assignment.",
  {
    template_id: z.string(),
    subject: z.string(),
    source_ref: z.string(),
    context_ref: z.string().optional(),
    project: z.string().optional(),
    human_owner: z.string().optional().default("tony"),
    proposed_by: z.string(),
  },
  (args) => modelSelector.proposeWorkflow(args),
);

registerTool(
  server,
  "propose_work_item",
  "Propose delegated work in the Agent Work Ledger. Proposals require separate owner or policy approval before assignment.",
  {
    title: z.string(),
    objective: z.string(),
    proposed_by: z.string(),
    human_owner: z.string().optional().default("tony"),
    source_ref: z.string(),
    context_ref: z.string().optional(),
    project: z.string().optional(),
    priority: z.string().optional().default("normal"),
    budget_tokens: z.number().nonnegative().optional(),
    review_policy: z.enum(["none", "human", "independent_agent"]).optional().default("none"),
    acceptance_criteria: z.array(z.string()).optional().default([]),
    tags: z.array(z.string()).optional().default([]),
  },
  (args) => workLedger.create(args),
);

registerTool(
  server,
  "list_work_items",
  "List Agent Work Ledger items, optionally filtered by task status, assigned agent, or project.",
  {
    status: z.enum(["proposed", "ready", "in_progress", "blocked", "review", "done", "canceled"]).optional(),
    agent_id: z.string().optional(),
    project: z.string().optional(),
  },
  (args) => workLedger.list(args),
);

registerTool(
  server,
  "get_work_item",
  "Read one work item and its append-only event history.",
  { work_item_id: z.string() },
  (args) => workLedger.get(args),
);

registerTool(
  server,
  "start_work_run",
  "Record the start of a provider-native run for an already approved and assigned work item.",
  {
    work_item_id: z.string(),
    actor: z.string(),
    provider: z.string().optional(),
    provider_session_ref: z.string().optional(),
    thread_id: z.string().optional(),
  },
  (args) => workLedger.startRun(args),
);

registerTool(
  server,
  "update_work_run",
  "Record run status and provider-reported token or cost usage. Missing costs remain unknown.",
  {
    work_item_id: z.string(),
    run_id: z.string(),
    status: z.enum(["queued", "dispatched", "acknowledged", "running", "waiting_input", "blocked", "submitted", "failed", "completed"]),
    actor: z.string(),
    input_tokens: z.number().nonnegative().optional(),
    output_tokens: z.number().nonnegative().optional(),
    estimated_cost: z.number().nonnegative().optional(),
    reason: z.string().optional(),
  },
  (args) => workLedger.updateRun(args),
);

registerTool(
  server,
  "submit_work_receipt",
  "Submit the evidence-bearing completion receipt required before a work item can finish.",
  {
    work_item_id: z.string(),
    submitted_by: z.string(),
    outcome: z.string(),
    summary: z.string(),
    evidence: z.array(z.string()).optional().default([]),
    deliverables: z.array(z.string()).optional().default([]),
    limitations: z.array(z.string()).optional().default([]),
    usage: z.object({
      input_tokens: z.number().nonnegative().optional(),
      output_tokens: z.number().nonnegative().optional(),
      total_tokens: z.number().nonnegative().optional(),
      estimated_cost: z.number().nonnegative().optional(),
    }).optional(),
  },
  (args) => workLedger.submitReceipt(args),
);

registerTool(
  server,
  "review_work_item",
  "Record an approval or request changes for a receipt awaiting review.",
  {
    work_item_id: z.string(),
    reviewer: z.string(),
    decision: z.enum(["approved", "changes_requested"]),
    summary: z.string(),
    evidence: z.array(z.string()).optional().default([]),
  },
  (args) => workLedger.review(args),
);

const transport = new StdioServerTransport();
await server.connect(transport);
