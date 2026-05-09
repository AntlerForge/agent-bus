# Agent Bus Setup

This guide is the public, generic setup path. It assumes the repository has been cloned
locally and that Node.js is available.

## 1. Run Setup

```bash
cd /path/to/agent-bus
./setup.sh
```

The script:

- installs npm dependencies if `node_modules/` is missing;
- creates the runtime mailbox at `~/AgentBus` unless `AGENT_BUS_ROOT` is already set;
- creates `inbox/`, `threads/`, `shared/`, and `archive/`;
- writes `.agent-bus.local.json`, which is ignored by Git;
- prints the Codex and Claude MCP setup commands for your local paths.

## 2. Grant Folder Access

Both participating agents need access to:

- the Agent Bus project folder, for running the MCP server and bridge scripts;
- the runtime mailbox folder, usually `~/AgentBus`;
- the `shared/` folder inside the runtime mailbox, for file handoff.

If an agent host uses sandboxed folder grants, add both the project folder and the runtime
mailbox folder. If either agent cannot read or write `shared/`, artifact handoff will fail
even if text messages work.

## 3. Configure MCP Servers

The setup script prints commands tailored to your machine. The generic shapes are:

Codex config:

```toml
[mcp_servers.agent-bus]
command = "node"
args = ["/path/to/agent-bus/src/server.mjs"]
env = { AGENT_BUS_ROOT = "~/AgentBus" }
```

Claude:

```bash
claude mcp add --transport stdio --scope user --env AGENT_BUS_ROOT="$HOME/AgentBus" agent-bus -- node /path/to/agent-bus/src/server.mjs
```

Claude Code channel:

```bash
claude mcp add --transport stdio --scope user --env AGENT_BUS_ROOT="$HOME/AgentBus" agent-bus-channel -- node /path/to/agent-bus/src/claude-channel.mjs
```

Restart the relevant agent host after MCP registration.

## 4. Start Automatic Responders

Claude Code:

```bash
claude --dangerously-load-development-channels server:agent-bus-channel
```

Codex bridge:

```bash
cd /path/to/agent-bus
AGENT_BUS_ROOT="$HOME/AgentBus" node src/codex-bridge.mjs --model gpt-5.2
```

Keep the Codex bridge terminal open while you want target `codex` to reply
automatically.

## 5. Test The Bus

From one agent, send a message to `codex` or `claude-code` with
`requires_response: true`. Confirm that:

- the message appears under `~/AgentBus/inbox/<target>/`;
- the target acknowledges it;
- a reply appears in the same thread;
- the thread status moves to `completed`, `input_required`, `blocked`, or `failed`.

For artifact handoff, put a small test file under `~/AgentBus/shared/` and send a message
that references it through `artifact_paths`.
