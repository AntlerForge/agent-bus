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
};

export async function readAgents(root) {
  const paths = await ensureBusLayout(root);
  const agents = await readJsonFile(paths.agentsFile, null);
  if (agents) {
    return agents;
  }
  await writeJsonFileAtomic(paths.agentsFile, DEFAULT_AGENTS);
  return structuredClone(DEFAULT_AGENTS);
}

export async function registerAgent({ agent_id, display_name, type = "unknown", capabilities = [] }, root) {
  if (!agent_id) {
    throw new Error("agent_id is required");
  }
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
}

export async function touchAgent(agent_id, root) {
  if (!agent_id) {
    return null;
  }
  const agents = await readAgents(root);
  const agent = agents[agent_id];
  if (!agent) {
    return null;
  }
  agent.last_seen = nowIso();
  const paths = await ensureBusLayout(root);
  await writeJsonFileAtomic(paths.agentsFile, agents);
  return agent;
}

export async function listAgents(root) {
  const agents = await readAgents(root);
  return Object.values(agents);
}
