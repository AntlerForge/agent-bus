# Agent Bus

Local-first bridge for agent-to-agent messaging between Claude, Codex, and other
LLM agents on macOS.

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

## Local Layout

Runtime mailbox data should live outside iCloud:

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

## Codex Terminal Bridge Setup

For symmetric automatic response on the Codex side, run the terminal bridge in a visible
Terminal window:

```bash
cd /path/to/agent-bus
node src/codex-bridge.mjs --model gpt-5.2
```

The bridge creates or resumes one persistent Codex CLI session and stores the session id
in `~/AgentBus/_codex_bridge_session.json`. It watches
`~/AgentBus/inbox/codex`. When it finds an unread message with
`requires_response: true`, it acknowledges the message, resumes the same Codex session on
the delegated task, writes the reply back to the sender, marks the inbound message read,
and updates thread status.

The same terminal also gives you a visible prompt:

```text
agent-bus>
```

Anything you type there is sent into the same persistent Codex session used for Claude
messages, so you and Claude are both interacting with one responder context. Use
`/session` to see the active session id and `/quit` to close the bridge. To initiate the
other direction from this terminal, use:

```text
/send claude-code | Subject | Body
```

Use `--new-session` when you intentionally want to reset the bridge context.

This is the Codex-side equivalent of the Claude Code terminal setup. It is not a Codex app
chat injection API; it is a visible terminal bridge backed by a persistent Codex CLI
session. With the current installed Codex CLI, `gpt-5.2` is the working default. Newer
models such as `gpt-5.4` or `gpt-5.5` can be selected with `--model` after the local Codex
CLI supports them.

## First Workflow

1. Claude writes a message to Codex using the MCP tool.
2. Codex checks its inbox and acknowledges the message.
3. Codex replies into the same thread and updates the thread status if appropriate.
4. Claude checks the reply and continues.

Automation is now split by side: Claude Code receives messages through
`agent-bus-channel`; Codex receives messages through the visible `agent-bus-codex-bridge`
terminal process.

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

## Support, Security, And Contributions

This is maintained by one person with a full-time job. Feedback, issues, and pull
requests are welcome, but I cannot promise response times or individual setup support.

See `SUPPORT.md` for support expectations, `SECURITY.md` for the local trust model and
safe-use guidance, and `CONTRIBUTING.md` for contribution notes.
