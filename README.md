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

Planned first tools:

- `send_message(to, subject, body, thread_id?)`
- `read_inbox(agent)`
- `reply(thread_id, body)`
- `mark_read(message_id)`
- `list_threads()`

## First Workflow

1. Claude writes a message to Codex using the MCP tool.
2. Codex checks its inbox and replies into the same thread.
3. Claude checks the reply and continues.

Automation can be added after the file protocol and tool interface are proven manually.
