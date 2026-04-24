#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { formatChannelContent, channelMeta, readPendingAgentMessages } from "./channel-messages.mjs";
import { ensureBusLayout, getBusRoot } from "./paths.mjs";

const root = getBusRoot();
const channelAgent = process.env.AGENT_BUS_CHANNEL_AGENT || "claude-code";
const pollMs = Number.parseInt(process.env.AGENT_BUS_CHANNEL_POLL_MS || "3000", 10);
const seen = new Set();

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
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

async function emitPending(mcp, { force = false } = {}) {
  const messages = await readPendingAgentMessages(root, channelAgent);
  const emitted = [];

  for (const message of messages) {
    if (!force && seen.has(message.message_id)) {
      continue;
    }

    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: formatChannelContent(message),
        meta: channelMeta(message),
      },
    });
    seen.add(message.message_id);
    emitted.push(message.message_id);
  }

  return { agent: channelAgent, emitted_count: emitted.length, emitted, pending_count: messages.length };
}

await ensureBusLayout(root);

const mcp = new Server(
  { name: "agent-bus-channel", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      "Agent Bus events arrive as <channel source=\"agent-bus-channel\" message_id=\"...\" thread_id=\"...\">. Treat each event as a delegated task from Codex. Use the separate agent-bus MCP tools to acknowledge the inbound message, do the requested work in this Claude Code session, reply to Codex in the same thread, mark the inbound message read, and update thread status. Do not ask the user what to do unless blocked.",
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_pending_agent_bus_messages",
      description: "List unread Claude Code Agent Bus messages that require a response.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "emit_pending_agent_bus_messages",
      description: "Push pending Claude Code Agent Bus messages into this Claude Code session as channel events.",
      inputSchema: {
        type: "object",
        properties: {
          force: {
            type: "boolean",
            description: "Emit messages even if this channel server has already emitted them in this process.",
          },
        },
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (request.params.name === "list_pending_agent_bus_messages") {
      return textResult(await readPendingAgentMessages(root, channelAgent));
    }
    if (request.params.name === "emit_pending_agent_bus_messages") {
      return textResult(await emitPending(mcp, request.params.arguments || {}));
    }
    throw new Error(`Unknown tool: ${request.params.name}`);
  } catch (error) {
    return errorResult(error);
  }
});

mcp.oninitialized = () => {
  emitPending(mcp).catch((error) => {
    console.error(`agent-bus-channel initial emit failed: ${error.message}`);
  });

  setInterval(() => {
    emitPending(mcp).catch((error) => {
      console.error(`agent-bus-channel poll failed: ${error.message}`);
    });
  }, pollMs).unref();
};

await mcp.connect(new StdioServerTransport());
