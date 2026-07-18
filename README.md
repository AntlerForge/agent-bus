# Agent Bus

Local-first bridge for agent-to-agent messaging between Claude, Codex, and other
LLM agents on macOS.

Agent Bus now also includes an adjacent, optional **Agent Work Ledger**. The bus
owns transport; the ledger owns delegated-work status, assignments, runs,
receipts, reviews, and recorded token usage. They share a dashboard without
conflating message delivery with task completion.

Agent Bus gives agents a shared mailbox, shared file area, durable threads, and simple
operating rules. It is useful when you want one model to stay in charge of a project while
delegating work to another model for a different strength, capability, or rate limit.

Examples:

- ask Codex to generate or edit an image for a Claude-led workflow;
- ask Claude for an independent review of Codex's implementation;
- hand off research, drafting, test runs, or critique between agents;
- continue progressing a project when one provider's rate limit is tight;
- keep a visible Markdown audit trail of what was asked, answered, blocked, or completed.

The first design target is deliberately simple:

- both agents connect to the same local MCP server;
- messages are stored as Markdown in a shared local directory;
- each message has explicit sender, recipient, thread, status, and timestamps;
- the file store remains readable and recoverable without any special tooling.

## Quick Start

```bash
git clone https://github.com/AntlerForge/agent-bus.git
cd agent-bus
./setup.sh
npm test
```

The setup script creates the runtime mailbox, installs dependencies if needed, writes an
ignored local config file, and prints the exact Codex and Claude MCP commands for your
machine.

Both agents need access to the project folder and the runtime mailbox folder. If your
agent host uses sandboxed folder grants, add both folders during setup. The `shared/`
folder is the artifact exchange point for screenshots, drafts, logs, patches, images, and
other files too large to inline in a message.

## Local Development Layout

For a standalone development instance, runtime mailbox data should live outside iCloud:

```text
~/AgentBus/
  inbox/
    claude/
    codex/
  threads/
  shared/
  archive/
```

Use `shared/` for artifacts that are too large or awkward to put directly in a message:
draft documents, logs, screenshots, patches, JSON exports, and similar files. Mailbox
messages should reference shared files by absolute path.

In Tony's deployment, A6 owns this runtime. Mac clients use
`AGENT_BUS_CONTROL_PLANE_URL=http://127.0.0.1:18091/agent-bus`; `~/AgentBus` is not a
second production ledger.

Project source lives wherever you cloned this repository:

```text
/path/to/agent-bus/
```

## Initial MCP Tools

Implemented first tools:

- `send_message(from, to, subject, body, thread_id?)`
- `read_inbox(agent)`
- `reply(from, to, thread_id, body)`
- `ack_message(message_id)`
- `mark_read(message_id)`
- `update_thread_status(thread_id, status)`
- `list_threads()`
- `register_agent(agent_id, display_name, capabilities?)`
- `list_agents()`
- `list_artifacts()`

Work Ledger tools:

- `propose_work_item(...)`
- `list_work_items(status?, agent_id?, project?)`
- `get_work_item(work_item_id)`
- `start_work_run(...)`
- `update_work_run(...)`
- `submit_work_receipt(...)`
- `review_work_item(...)`

Agents can propose and operate their assigned runs. Human approval and assignment
remain dashboard-owner controls in the first release.

Model routing tools are advisory and never dispatch work:

- `get_model_selector(route_id?, task_category?)`
- `propose_routing_workflow(template_id, subject, source_ref, ...)`

The selector is a read-only, versioned Knowledge Vault input. Workflow templates
create linked Work Ledger items in `proposed` state so the user can inspect,
approve and assign each recommendation in the dashboard.

## Web Control Plane

Run `npm run state:lint` for deterministic ledger/thread integrity checks. Unknown provider
token usage remains `null`; completion receipts require target-state, location, and read-only
verification evidence. See `docs/agent-work-ledger.md` for the full outcome contract.

Run the dashboard locally:

```bash
npm run dashboard
```

Then open `http://127.0.0.1:8091/`. The service refuses non-localhost binds and
exposes `/healthz`, `/version`, and `/api/v1` alongside the browser UI.

Set `AGENT_BUS_SELECTOR_PATH` to a selector v3 directory to enable the **Model
routes** view. Validate the contract independently with:

```bash
npm run selector:check -- /path/to/llm-selector/v3
```

For Tony's installation, the durable dashboard and Work Ledger run on A6. Codex,
Cursor, Antigravity and desktop-native adapters remain on the Mac and point their
Work Ledger MCP tools at the A6 control plane. This preserves access to native app
sessions without creating a second task authority.

The taskable target IDs are:

| Target | Native execution surface | Automatic when |
|---|---|---|
| `codex` | Codex CLI, `gpt-5.6-sol` | Codex LaunchAgent is running |
| `cursor` | Cursor Agent CLI, Grok 4.5 High | Cursor LaunchAgent is running |
| `antigravity` | Antigravity `agy` CLI, Gemini 3.5 Flash Medium | Antigravity LaunchAgent is running |
| `claude-code` | Claude Code channel | A Claude Code channel session is open |

Registration alone does not prove a target is taskable. A bridge heartbeat shows that its
adapter is running; acknowledgement and an in-thread reply prove delivery.

Messages that should trigger the recipient to act should set `requires_response: true`.
Replies and informational receipts should leave `requires_response` false unless they are
asking a new question or assigning a new task.

## Codex Setup

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.agent-bus]
command = "node"
args = ["/path/to/agent-bus/src/server.mjs"]
env = { AGENT_BUS_ROOT = "~/AgentBus" }
```

Then restart or reload Codex so it discovers the MCP server.

## Claude Setup

For Claude Code, add the MCP server at user scope:

```bash
claude mcp add --transport stdio --scope user --env AGENT_BUS_ROOT="$HOME/AgentBus" agent-bus -- node /path/to/agent-bus/src/server.mjs
```

Then restart or reload Claude as needed.

## Claude Code Channel Setup

For automatic delivery into a running Claude Code session, also register the channel
server:

```bash
claude mcp add --transport stdio --scope user --env AGENT_BUS_ROOT="$HOME/AgentBus" agent-bus-channel -- node /path/to/agent-bus/src/claude-channel.mjs
```

Start Claude Code with the development channel enabled:

```bash
claude --dangerously-load-development-channels server:agent-bus-channel
```

While that session is running, any unread message addressed to `claude-code` with
`requires_response: true` is pushed into the session as a Claude Code channel event.
Claude should then use the normal `agent-bus` MCP tools to acknowledge, reply, mark read,
and update thread status.

## Native Auto-Responder Bridges

The Mac bridges poll A6, acknowledge actionable messages, download attached artifacts,
run the native provider CLI, reply in the same thread and update transport status. Cursor
and Antigravity preserve a provider session per Agent Bus thread. Codex resumes its
dedicated persistent bridge session. Provider state lives under
`~/Library/Application Support/Agent Bus/`, separate from the A6 ledger.

For foreground development:

```bash
AGENT_BUS_CONTROL_PLANE_URL=http://127.0.0.1:18091/agent-bus node src/codex-bridge.mjs --model gpt-5.6-sol --no-input
AGENT_BUS_CONTROL_PLANE_URL=http://127.0.0.1:18091/agent-bus node src/cursor-bridge.mjs --model cursor-grok-4.5-high --workspace "$HOME"
AGENT_BUS_CONTROL_PLANE_URL=http://127.0.0.1:18091/agent-bus node src/antigravity-bridge.mjs --model "Gemini 3.5 Flash (Medium)" --workspace "$HOME"
```

Production Mac setup uses the LaunchAgent examples in `deploy/macos/`; they start at login
and restart after failure. The Codex bridge ignores the user's normal MCP/plugin config by
default so unrelated OAuth problems cannot break unattended tasks.

Prove all three live paths, including artifact transfer, with:

```bash
npm run bridge:test -- --target codex --target cursor --target antigravity --artifact
```

## First Workflow

1. Claude writes a message to Codex using the MCP tool.
2. Codex checks its inbox and acknowledges the message.
3. Codex replies into the same thread and updates the thread status if appropriate.
4. Claude checks the reply and continues.

Automation is split by native surface: provider bridges serve `codex`, `cursor` and
`antigravity`; the Claude Code channel serves `claude-code` while that session is open.

## Development

Run tests:

```bash
npm test
```

GitHub Actions runs the same test suite on Node.js 20 and 22 for pushes and pull
requests.

## Companion Skills

Repo source copies live in:

```text
skills/codex/agent-bus/SKILL.md
skills/claude/agent-bus/SKILL.md
```

Installed local copies live in:

```text
~/.codex/skills/agent-bus/SKILL.md
~/.claude/skills/agent-bus/SKILL.md
```

The skills define Agent Bus operating behavior: actionable inbound messages should be
acknowledged, handled, replied to, marked read, and given a thread status without asking
the user what to do unless there is a real blocker.

## User Guide

See `docs/user-guide.md` for the full operator guide covering aims, setup, targeting,
automatic responders, in-app chats, CLI sessions, and troubleshooting.

See `docs/setup.md` for the generic installation and folder-access guide.

See `docs/one-page-agent-bus-guide.md` for a concise structure guide covering agent
types, connector behavior, control flags, and targeting rules.

See `docs/public-release-checklist.md` before making a private working copy public.

See `docs/agent-work-ledger.md` for the task lifecycle, storage layout, dashboard
workflow, remote MCP setup and A6 deployment boundary.

## Support, Security, And Contributions

This is maintained by one person with a full-time job. Feedback, issues, and pull
requests are welcome, but I cannot promise response times or individual setup support.

See `SUPPORT.md` for support expectations, `SECURITY.md` for the local trust model and
safe-use guidance, and `CONTRIBUTING.md` for contribution notes.
