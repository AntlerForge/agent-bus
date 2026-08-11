import { nowIso } from "./ids.mjs";
import { readJsonFile, writeJsonFileAtomic } from "./io.mjs";
import { ensureBusLayout } from "./paths.mjs";

const DEFAULT_AGENTS = {
  claude: {
    agent_id: "claude",
    display_name: "Claude",
    type: "claude-generic",
    capabilities: ["analysis", "writing", "coding", "review"],
    last_seen: null,
  },
  "claude-code": {
    agent_id: "claude-code",
    display_name: "Claude Code",
    type: "claude-code",
    capabilities: ["analysis", "writing", "coding", "review"],
    last_seen: null,
  },
  codex: {
    agent_id: "codex",
    display_name: "Codex",
    type: "codex",
    capabilities: ["coding", "debugging", "review", "local-tools"],
    last_seen: null,
  },
  cursor: {
    agent_id: "cursor",
    display_name: "Cursor",
    type: "cursor",
    capabilities: ["coding", "debugging", "review", "ide-context"],
    last_seen: null,
  },
  antigravity: {
    agent_id: "antigravity",
    display_name: "Antigravity",
    type: "antigravity",
    capabilities: ["coding", "analysis", "review"],
    last_seen: null,
  },
  "openai-desktop": {
    agent_id: "openai-desktop",
    display_name: "OpenAI Desktop",
    type: "openai-desktop",
    capabilities: ["analysis", "writing", "coding", "connectors"],
    last_seen: null,
  },
};

let agentWriteQueue = Promise.resolve();

function serializeAgentWrite(operation) {
  const queued = agentWriteQueue.then(operation, operation);
  agentWriteQueue = queued.catch(() => {});
  return queued;
}

export async function readAgents(root) {
  const paths = await ensureBusLayout(root);
  const agents = await readJsonFile(paths.agentsFile, null);
  if (agents) {
    let changed = false;
    for (const [agentId, defaultAgent] of Object.entries(DEFAULT_AGENTS)) {
      if (!agents[agentId]) {
        agents[agentId] = defaultAgent;
        changed = true;
      }
    }
    if (changed) {
      await writeJsonFileAtomic(paths.agentsFile, agents);
    }
    return agents;
  }
  await writeJsonFileAtomic(paths.agentsFile, DEFAULT_AGENTS);
  return structuredClone(DEFAULT_AGENTS);
}

export async function registerAgent({ agent_id, display_name, type = "unknown", capabilities = [] }, root) {
  if (!agent_id) {
    throw new Error("agent_id is required");
  }
  return serializeAgentWrite(async () => {
    const paths = await ensureBusLayout(root);
    const agents = await readAgents(root);
    const existing = agents[agent_id] || {};
    agents[agent_id] = {
      ...existing,
      agent_id,
      display_name: display_name || existing.display_name || agent_id,
      type: type || existing.type || "unknown",
      capabilities: Array.isArray(capabilities) ? capabilities : existing.capabilities || [],
      last_seen: nowIso(),
    };
    await writeJsonFileAtomic(paths.agentsFile, agents);
    return agents[agent_id];
  });
}

export const LIVENESS_THRESHOLDS = { fresh_seconds: 120, stale_seconds: 600 };

const HEARTBEAT_STATE_PATTERN = /^(idle|connected|disconnected|working:[A-Za-z0-9._:-]+)$/;

export function classifyLiveness(lastHeartbeatIso, nowMs = Date.now()) {
  if (!lastHeartbeatIso) return "unknown";
  const seenMs = new Date(lastHeartbeatIso).getTime();
  if (!Number.isFinite(seenMs)) return "unknown";
  const ageSeconds = (nowMs - seenMs) / 1000;
  if (ageSeconds < LIVENESS_THRESHOLDS.fresh_seconds) return "fresh";
  if (ageSeconds < LIVENESS_THRESHOLDS.stale_seconds) return "stale";
  return "down";
}

export async function heartbeatAgent({ agent_id, host, pid, bridge_version, state, queue_depth }, root) {
  if (!agent_id) {
    throw new Error("agent_id is required");
  }
  const normalizedState = String(state || "idle");
  if (!HEARTBEAT_STATE_PATTERN.test(normalizedState)) {
    throw new Error("state must be idle, connected, disconnected or working:<thread_id>");
  }
  return serializeAgentWrite(async () => {
    const paths = await ensureBusLayout(root);
    const agents = await readAgents(root);
    const existing = agents[agent_id] || { agent_id, display_name: agent_id, type: "unknown", capabilities: [] };
    const timestamp = nowIso();
    agents[agent_id] = {
      ...existing,
      agent_id,
      last_seen: timestamp,
      liveness: {
        host: host ? String(host) : null,
        pid: Number.isFinite(Number(pid)) ? Number(pid) : null,
        bridge_version: bridge_version ? String(bridge_version) : null,
        state: normalizedState,
        current_thread_id: normalizedState.startsWith("working:") ? normalizedState.slice("working:".length) : null,
        queue_depth: Number.isFinite(Number(queue_depth)) ? Number(queue_depth) : null,
        last_heartbeat: timestamp,
      },
    };
    await writeJsonFileAtomic(paths.agentsFile, agents);
    return agents[agent_id];
  });
}

const AGENT_LIFECYCLE_STATUSES = ["active", "retired"];

export async function setAgentLifecycleStatus({ agent_id, status, actor }, root) {
  if (!agent_id) {
    throw new Error("agent_id is required");
  }
  if (!AGENT_LIFECYCLE_STATUSES.includes(status)) {
    throw new Error(`status must be one of: ${AGENT_LIFECYCLE_STATUSES.join(", ")}`);
  }
  return serializeAgentWrite(async () => {
    const paths = await ensureBusLayout(root);
    const agents = await readAgents(root);
    const agent = agents[agent_id];
    if (!agent) {
      const error = new Error(`Unknown agent: ${agent_id}`);
      error.statusCode = 404;
      throw error;
    }
    agent.lifecycle_status = status;
    agent.lifecycle_changed_at = nowIso();
    agent.lifecycle_changed_by = actor ? String(actor) : null;
    await writeJsonFileAtomic(paths.agentsFile, agents);
    return agent;
  });
}

export async function touchAgent(agent_id, root) {
  if (!agent_id) {
    return null;
  }
  return serializeAgentWrite(async () => {
    const agents = await readAgents(root);
    const agent = agents[agent_id];
    if (!agent) {
      return null;
    }
    agent.last_seen = nowIso();
    const paths = await ensureBusLayout(root);
    await writeJsonFileAtomic(paths.agentsFile, agents);
    return agent;
  });
}

export async function listAgents(root) {
  const agents = await readAgents(root);
  return Object.values(agents);
}
