# Agent Bus

Local bridge for agent-to-agent messaging between Claude and Codex on macOS.

The first design target is deliberately simple:

- both agents connect to the same local MCP server;
- messages are stored as Markdown in a shared local directory;
- each message has explicit sender, recipient, thread, status, and timestamps;
- the file store remains readable and recoverable without any special tooling.

## Local Layout

Runtime mailbox data should live outside iCloud:

```text
/Users/antonybarfoot/AgentBus/
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

Project source lives here:

```text
/Users/antonybarfoot/Developer/personal/agent-bus/
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
args = ["/Users/antonybarfoot/Developer/personal/agent-bus/src/server.mjs"]
```

Then restart or reload Codex so it discovers the MCP server.

## Claude Setup

For Claude Code, add the MCP server at user scope:

```bash
claude mcp add --transport stdio --scope user agent-bus -- node /Users/antonybarfoot/Developer/personal/agent-bus/src/server.mjs
```

Then restart or reload Claude as needed.

## Claude Code Channel Setup

For automatic delivery into a running Claude Code session, also register the channel
server:

```bash
claude mcp add --transport stdio --scope user agent-bus-channel -- node /Users/antonybarfoot/Developer/personal/agent-bus/src/claude-channel.mjs
```

Start Claude Code with the development channel enabled:

```bash
claude --dangerously-load-development-channels server:agent-bus-channel
```

While that session is running, any unread message addressed to `claude-code` with
`requires_response: true` is pushed into the session as a Claude Code channel event.
Claude should then use the normal `agent-bus` MCP tools to acknowledge, reply, mark read,
and update thread status.

## First Workflow

1. Claude writes a message to Codex using the MCP tool.
2. Codex checks its inbox and acknowledges the message.
3. Codex replies into the same thread and updates the thread status if appropriate.
4. Claude checks the reply and continues.

Automation can be added after the file protocol and tool interface are proven manually.

## Development

Run tests:

```bash
npm test
```

## Companion Skills

Repo source copies live in:

```text
skills/codex/agent-bus/SKILL.md
skills/claude/agent-bus/SKILL.md
```

Installed local copies live in:

```text
/Users/antonybarfoot/.codex/skills/agent-bus/SKILL.md
/Users/antonybarfoot/.claude/skills/agent-bus/SKILL.md
```

The skills define Agent Bus operating behavior: actionable inbound messages should be
acknowledged, handled, replied to, marked read, and given a thread status without asking
the user what to do unless there is a real blocker.
