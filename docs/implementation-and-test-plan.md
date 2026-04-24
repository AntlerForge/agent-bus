# Agent Bus Implementation and Test Plan

## 1. Implementation Strategy

Build the system in small working stages:

1. Establish the filesystem protocol.
2. Implement the local MCP server.
3. Connect Codex to the MCP server.
4. Connect Claude to the MCP server.
5. Prove manual bidirectional messaging.
6. Add automation only after the manual workflow is reliable.

The first build should optimise for clarity and inspectability over sophistication.

## 2. Proposed Technology

Initial implementation:

- Node.js MCP server using stdio transport.
- Plain Markdown message and thread files.
- JSON or YAML frontmatter for metadata.
- Local filesystem storage under `/Users/antonybarfoot/AgentBus/`.

The server should avoid external services and heavy dependencies unless they clearly reduce
implementation risk.

## 3. Repository Layout

Proposed source layout:

```text
/Users/antonybarfoot/Developer/personal/agent-bus/
  README.md
  docs/
    user-requirements.md
    implementation-and-test-plan.md
  src/
    server.mjs
    mailbox.mjs
    paths.mjs
    markdown.mjs
  test/
    mailbox.test.mjs
    fixtures/
  package.json
```

Runtime data layout:

```text
/Users/antonybarfoot/AgentBus/
  inbox/
    claude/
    codex/
  threads/
  shared/
  archive/
```

## 4. Message File Format

Each inbox message should be a Markdown file with frontmatter:

```markdown
---
id: msg_20260424_153000_ab12
thread: thread_agent_bus_design
from: claude
to: codex
status: unread
created: 2026-04-24T15:30:00+01:00
subject: Review Agent Bus design
---

# Review Agent Bus design

Please review the design in:

/Users/antonybarfoot/AgentBus/shared/agent-bus-design.md
```

Thread files should be append-only Markdown where possible:

```markdown
---
id: thread_agent_bus_design
participants:
  - claude
  - codex
created: 2026-04-24T15:30:00+01:00
updated: 2026-04-24T15:45:00+01:00
---

# Review Agent Bus design

## 2026-04-24T15:30:00+01:00 - claude

...

## 2026-04-24T15:45:00+01:00 - codex

...
```

## 5. MCP Tool Behaviour

### `send_message(to, subject, body, thread_id?)`

Creates:

- one inbox message file for the recipient;
- a new thread file if `thread_id` is absent;
- an appended entry in the thread file.

Returns:

- message ID;
- thread ID;
- inbox file path;
- thread file path.

### `read_inbox(agent)`

Lists unread messages addressed to `agent`.

Returns:

- message IDs;
- subjects;
- senders;
- created timestamps;
- file paths;
- body summaries or full bodies, depending on implementation simplicity.

### `reply(thread_id, body)`

Appends a reply to the thread and creates a message for the other participant.

The first version may require an explicit `from` or `to` field if inferring the recipient
is ambiguous.

### `mark_read(message_id)`

Marks an inbox message as read.

The first implementation can either:

- update the `status` field in place; or
- move the message to `archive/`.

Updating frontmatter in place is clearer for manual inspection. Moving to archive is safer
for avoiding repeated reads. Choose one and document it before implementation.

### `list_threads()`

Lists known thread files with IDs, subjects, participants, and updated timestamps.

## 6. Setup Plan

### Phase 1: Filesystem Foundation

- Verify `/Users/antonybarfoot/AgentBus/` exists.
- Create missing runtime folders on server start.
- Define message ID and thread ID conventions.
- Implement Markdown/frontmatter read and write helpers.

Exit criteria:

- A local script can create a valid message and thread file.

### Phase 2: MCP Server

- Add `package.json`.
- Add MCP server entrypoint.
- Register the planned tools.
- Route tool calls to filesystem operations.
- Return clear success/error payloads.

Exit criteria:

- Tools can be called locally and produce correct files.

### Phase 3: Codex Connection

- Add Codex MCP config in `~/.codex/config.toml`:

```toml
[mcp_servers.agent-mailbox]
command = "node"
args = ["/Users/antonybarfoot/Developer/personal/agent-bus/src/server.mjs"]
```

- Restart or reload Codex as required.
- Confirm Codex can see and call the mailbox tools.

Exit criteria:

- Codex can send a message to Claude through the tool.

### Phase 4: Claude Connection

- Add the same MCP server to Claude Code or Claude Desktop.
- Prefer user scope initially so the mailbox is available across chats.

Expected Claude Code command:

```bash
claude mcp add --transport stdio --scope user agent-mailbox -- node /Users/antonybarfoot/Developer/personal/agent-bus/src/server.mjs
```

Exit criteria:

- Claude can send a message to Codex through the tool.

### Phase 5: Manual End-to-End Workflow

Run the first full manual loop:

1. Ask Claude to send Codex a message.
2. Ask Codex to read its inbox.
3. Ask Codex to reply.
4. Ask Claude to read its inbox.
5. Inspect the Markdown files manually.

Exit criteria:

- Both directions work.
- Thread history is readable.
- Inbox status is understandable.

### Phase 6: Automation

Only after manual operation is reliable:

- evaluate Claude hooks/channels for mailbox notification;
- evaluate Codex automations or polling;
- consider a small local watcher if necessary.

Exit criteria:

- At least one direction can be initiated without a manual "check inbox" prompt.

## 7. Test Plan

### Unit Tests

Test filesystem logic without MCP:

- creates missing folder structure;
- generates unique message IDs;
- creates a new thread when no thread ID is supplied;
- appends to an existing thread;
- writes valid Markdown files;
- reads unread inbox messages;
- marks messages read;
- handles unknown agents cleanly;
- handles missing thread IDs cleanly.

### Integration Tests

Test MCP tool calls against a temporary mailbox root:

- `send_message` writes inbox and thread files;
- `read_inbox` returns the sent message;
- `reply` appends to the thread and creates the recipient message;
- `mark_read` prevents the message appearing as unread again;
- `list_threads` returns created threads.

### Manual Acceptance Tests

Run against `/Users/antonybarfoot/AgentBus/`:

1. Claude sends Codex a plain text question.
2. Codex reads and replies.
3. Codex sends Claude a plain text question.
4. Claude reads and replies.
5. Claude shares a file via `/Users/antonybarfoot/AgentBus/shared/`.
6. Codex opens or references that shared file.
7. User manually opens the thread file and can understand the exchange.

### Failure Tests

Check:

- recipient inbox folder is missing;
- shared file path in a message does not exist;
- message has malformed frontmatter;
- two messages are sent quickly and IDs remain unique;
- read inbox is called when there are no unread messages.

## 8. Open Design Decisions

These should be resolved during implementation:

- whether `mark_read` updates frontmatter or moves messages to archive;
- whether `reply` infers sender/recipient from current MCP client context or requires explicit fields;
- whether thread IDs are generated from subjects, timestamps, or opaque IDs;
- whether shared artifacts need a manifest file;
- how much automation is worthwhile after the manual flow works.

## 9. Initial Milestone

Milestone 1 is complete when a local MCP server supports manual Claude-to-Codex and
Codex-to-Claude messaging through Markdown files, with no automation required.
