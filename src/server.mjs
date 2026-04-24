#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listAgents, registerAgent } from "./agents.mjs";
import { readArtifactManifest } from "./artifacts.mjs";
import {
  ackMessage,
  listThreads,
  markRead,
  readInbox,
  replyMessage,
  sendMessage,
  updateThreadStatus,
} from "./mailbox.mjs";
import { ensureBusLayout, getBusRoot } from "./paths.mjs";

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
await ensureBusLayout(root);

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
    artifact_paths: artifactPaths,
    idempotency_key: z.string().optional(),
  },
  (args) => sendMessage(args, root),
);

registerTool(
  server,
  "read_inbox",
  "Read messages addressed to an agent.",
  {
    agent: z.string(),
    include_read: z.boolean().optional().default(false),
  },
  (args) => readInbox(args, root),
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
    artifact_paths: artifactPaths,
  },
  (args) => replyMessage(args, root),
);

registerTool(
  server,
  "ack_message",
  "Acknowledge receipt of a message without marking the task complete.",
  {
    message_id: z.string(),
  },
  (args) => ackMessage(args, root),
);

registerTool(
  server,
  "mark_read",
  "Mark a message as read in place.",
  {
    message_id: z.string(),
  },
  (args) => markRead(args, root),
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
  (args) => updateThreadStatus(args, root),
);

registerTool(server, "list_threads", "List known message threads.", {}, () => listThreads(root));

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
  (args) => registerAgent(args, root),
);

registerTool(server, "list_agents", "List known local agent identities.", {}, () => listAgents(root));

registerTool(server, "list_artifacts", "List shared artifact metadata.", {}, () => readArtifactManifest(root));

const transport = new StdioServerTransport();
await server.connect(transport);
