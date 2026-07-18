# Agent Bus Implementation and Test Plan

## 1. Implementation Strategy

Build the system in small working stages:

1. Establish the filesystem protocol.
2. Implement the local MCP server.
3. Add agent identity, acknowledgments, and task lifecycle state.
4. Connect Codex to the MCP server.
5. Connect Claude to the MCP server.
6. Prove manual bidirectional messaging.
7. Add automation only after the manual workflow is reliable.

The first build should optimise for clarity and inspectability over sophistication.

## 2. Proposed Technology

Initial implementation:

- Node.js MCP server using stdio transport.
- Plain Markdown message and thread files.
- JSON or YAML frontmatter for metadata.
- Local filesystem storage under `~/AgentBus/`.

The server should avoid external services and heavy dependencies unless they clearly reduce
implementation risk.

## 3. Repository Layout

Proposed source layout:

```text
/path/to/agent-bus/
  README.md
  docs/
    user-requirements.md
    implementation-and-test-plan.md
  src/
    server.mjs
    mailbox.mjs
    agents.mjs
    artifacts.mjs
    paths.mjs
    markdown.mjs
  test/
    mailbox.test.mjs
    agents.test.mjs
    artifacts.test.mjs
    fixtures/
  skills/
    codex/
      agent-bus/
        SKILL.md
    claude/
      agent-bus/
        SKILL.md
  package.json
```

Runtime data layout:

```text
~/AgentBus/
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
seq: 1
thread: thread_agent_bus_design
from: claude
to: codex
status: unread
created: 2026-04-24T15:30:00+01:00
subject: Review Agent Bus design
priority: normal
ack_required: true
requires_response: true
idempotency_key: optional-client-supplied-key
---

# Review Agent Bus design

Please review the design in:

~/AgentBus/shared/agent-bus-design.md
```

Thread files should be append-only Markdown where possible:

```markdown
---
id: thread_agent_bus_design
status: open
participants:
  - claude
  - codex
created: 2026-04-24T15:30:00+01:00
updated: 2026-04-24T15:45:00+01:00
next_seq: 3
---

# Review Agent Bus design

## 2026-04-24T15:30:00+01:00 - claude

...

## 2026-04-24T15:45:00+01:00 - codex

...
```

## 5. MCP Tool Behaviour

### `send_message(from, to, subject, body, thread_id?)`

Creates:

- one inbox message file for the recipient;
- a new thread file if `thread_id` is absent;
- an appended entry in the thread file.

Returns:

- message ID;
- thread ID;
- inbox file path;
- thread file path.

The implementation should accept optional `priority`, `ack_required`, `requires_response`,
`artifact_paths`, and `idempotency_key` fields.

### `read_inbox(agent)`

Lists unread messages addressed to `agent`. A later version should accept a `since_seq` or
cursor argument for efficient polling.

Returns:

- message IDs;
- subjects;
- senders;
- created timestamps;
- file paths;
- body summaries or full bodies, depending on implementation simplicity.

### `reply(from, to, thread_id, body)`

Appends a reply to the thread and creates a message for the recipient.

### `ack_message(message_id)`

Records that the recipient has seen and accepted receipt of the message.

Acknowledgment should not imply the task is complete.

### `update_thread_status(thread_id, status)`

Updates the lifecycle state for a thread.

Allowed initial statuses:

- `open`
- `acknowledged`
- `in_progress`
- `input_required`
- `blocked`
- `completed`
- `failed`
- `canceled`
- `closed`

### `mark_read(message_id)`

Marks an inbox message as read.

The first implementation can either:

- update the `status` field in place; or
- move the message to `archive/`.

Updating frontmatter in place is clearer for manual inspection. Moving to archive is safer
for avoiding repeated reads. Choose one and document it before implementation.

### `list_threads()`

Lists known thread files with IDs, subjects, participants, and updated timestamps.

### `register_agent(agent_id, display_name, capabilities?)`

Creates or updates an agent registry entry.

For the first implementation, bootstrap static entries for `claude` and `codex` if no
registry exists.

## 6. Artifact Handling

Shared artifacts should be referenced through metadata, not only free text paths.

Initial artifact metadata can be stored in:

```text
~/AgentBus/shared/_artifacts.json
```

Each artifact record should include:

- artifact ID;
- path;
- filename;
- MIME type or kind where known;
- producer;
- created timestamp;
- source message ID or thread ID;
- optional checksum.

The first implementation can register artifacts opportunistically when `send_message`
receives `artifact_paths`.

## 7. Setup Plan

### Phase 1: Filesystem Foundation

- Verify `~/AgentBus/` exists.
- Create missing runtime folders on server start.
- Define message ID and thread ID conventions.
- Define thread sequence/cursor conventions.
- Implement Markdown/frontmatter read and write helpers.
- Implement atomic write helpers.

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

### Phase 3: Identity, Lifecycle, and Artifacts

- Add agent registry file.
- Bootstrap `claude` and `codex` records.
- Add acknowledgment support.
- Add thread status updates.
- Add artifact metadata registration.

Exit criteria:

- A message can be acknowledged separately from being answered.
- A thread can move through lifecycle states.
- A shared artifact can be listed with metadata.

### Phase 4: Codex Connection

- Add Codex MCP config in `~/.codex/config.toml`:

```toml
[mcp_servers.agent-bus]
command = "node"
args = ["/path/to/agent-bus/src/server.mjs"]
```

- Restart or reload Codex as required.
- Confirm Codex can see and call the mailbox tools.

Exit criteria:

- Codex can send a message to Claude through the tool.

### Phase 5: Claude Connection

- Add the same MCP server to Claude Code or Claude Desktop.
- Prefer user scope initially so the mailbox is available across chats.

Expected Claude Code command:

```bash
claude mcp add --transport stdio --scope user --env AGENT_BUS_ROOT="$HOME/AgentBus" agent-bus -- node /path/to/agent-bus/src/server.mjs
```

Exit criteria:

- Claude can send a message to Codex through the tool.

### Phase 6: Manual End-to-End Workflow

Run the first full manual loop:

1. Ask Claude to send Codex a message.
2. Ask Codex to read its inbox and acknowledge the message.
3. Ask Codex to reply and mark the thread completed or input-required.
4. Ask Claude to read its inbox and acknowledge the reply.
5. Inspect the Markdown files manually.

Exit criteria:

- Both directions work.
- Acknowledgments are visible.
- Thread history is readable.
- Thread lifecycle status is understandable.

### Phase 7: Automation

Only after manual operation is reliable:

- add a Claude Code channel server for mailbox notification;
- add a persistent Codex terminal bridge for Codex inbox notification and user interaction;
- consider a small local watcher if necessary.

Exit criteria:

- At least one direction can be initiated without a manual "check inbox" prompt.

### Phase 8: Claude Code Channel

- Add `src/claude-channel.mjs` as a second MCP server.
- Advertise `capabilities.experimental["claude/channel"]`.
- Watch `inbox/claude-code` for unread messages where `requires_response: true`.
- Emit `notifications/claude/channel` with `content` and identifier-safe `meta`.
- Keep replies on the normal `agent-bus` MCP server so thread state remains canonical.
- Register the server as `agent-bus-channel` in Claude Code config.

Expected test command for local channel development:

```bash
claude --dangerously-load-development-channels server:agent-bus-channel
```

Exit criteria:

- A Codex-to-Claude Code message arrives in the running Claude Code session without the user
  asking Claude to check its inbox.

### Phase 9: Codex Terminal Bridge

- Add `src/codex-bridge.mjs` as a visible terminal bridge backed by Codex CLI.
- Create or resume one dedicated Codex CLI session and store its id in
  `~/Library/Application Support/Agent Bus/codex/sessions.json`.
- Send both Agent Bus messages and user terminal input into that same Codex session so
  responder context persists.
- Add a terminal `/send claude-code | Subject | Body` command for Codex-to-Claude Code
  task initiation from the same visible bridge window.
- Poll the configured A6 control-plane inbox on a short interval; use the local inbox only
  in explicit standalone-development mode.
- Process only unread messages addressed to `codex` where `requires_response: true`.
- Acknowledge, resume the persistent Codex session on the delegated task, reply in-thread,
  mark read, and update lifecycle status.
- Default replies to `requires_response: false` to avoid loops.

Exit criteria:

- A Claude Code-to-Codex message is picked up by the Codex terminal bridge without the user
  asking Codex to check its inbox.
- A second Claude Code-to-Codex message can rely on context established by the first
  message or by user input typed into the bridge terminal.

## 8. Test Plan

### Unit Tests

Test filesystem logic without MCP:

- creates missing folder structure;
- generates unique message IDs;
- creates a new thread when no thread ID is supplied;
- appends to an existing thread;
- increments thread sequence numbers monotonically;
- deduplicates sends with the same idempotency key;
- writes valid Markdown files;
- reads unread inbox messages;
- records message acknowledgments;
- marks messages read;
- updates thread lifecycle state;
- registers shared artifact metadata;
- rejects paths outside the configured Agent Bus root unless explicitly allowed;
- handles unknown agents cleanly;
- handles missing thread IDs cleanly.

### Integration Tests

Test MCP tool calls against a temporary mailbox root:

- `send_message` writes inbox and thread files;
- `read_inbox` returns the sent message;
- `ack_message` records receipt without completing the task;
- `reply` appends to the thread and creates the recipient message;
- `update_thread_status` changes thread status and preserves an audit trail;
- `mark_read` prevents the message appearing as unread again;
- `list_threads` returns created threads;
- artifact paths are captured in the artifact manifest.
- the channel server advertises `claude/channel`;
- the channel server emits a channel notification for a pending Claude message.

### Manual Acceptance Tests

Run against `~/AgentBus/`:

1. Claude sends Codex a plain text question.
2. Codex reads and acknowledges the message.
3. Codex replies.
3. Codex sends Claude a plain text question.
4. Claude reads, acknowledges, and replies.
5. A thread moves to `completed`.
6. Claude shares a file via `~/AgentBus/shared/`.
7. Codex opens or references that shared file.
8. User manually opens the thread file and can understand the exchange.
9. Start Claude Code with `--dangerously-load-development-channels server:agent-bus-channel`.
10. Codex sends Claude Code a `requires_response: true` message.
11. Claude receives the channel event in the active session and replies through Agent Bus.
12. Claude Code sends Codex a `requires_response: true` message.
13. The Codex terminal bridge wakes, resumes its persistent Codex session, and replies
    through Agent Bus.
14. Type a short fact into the `agent-bus>` prompt, then send a Claude Code-to-Codex
    message asking Codex to recall it; Codex should answer from the same persistent
    session context.
15. Use `/send claude-code | Smoke | Reply with received` from the Codex bridge terminal
    and confirm Claude Code receives it through the channel.

### Failure Tests

Check:

- recipient inbox folder is missing;
- shared file path in a message does not exist;
- message has malformed frontmatter;
- two messages are sent quickly and IDs remain unique;
- read inbox is called when there are no unread messages;
- the same send is retried after a simulated timeout;
- a path traversal attempt is supplied as a shared artifact path;
- a message appears to contain a secret.

## 9. Design Decisions for Milestone 1

The following decisions are locked for the first implementation:

- MCP server name: `agent-bus`.
- `mark_read` updates message frontmatter in place; archive movement is deferred.
- `reply` requires explicit `from` and `to` fields.
- Thread IDs are opaque IDs such as `thread_20260424_123456_ab12`; subject is stored separately.
- Thread sequence state lives in the thread file frontmatter as `next_seq`.
- Shared artifacts use one manifest at `~/AgentBus/shared/_artifacts.json`.
- Secret detection blocks obvious secrets with a clear tool error.
- Advisory file reservations are deferred until after Milestone 1.
- Automation uses Claude Code channels for Claude Code and a persistent Codex terminal
  bridge for Codex.

Remaining implementation choice:

- exact secret patterns for the first detector.

## 10. Initial Milestone

Milestone 1 is complete when a local MCP server supports manual Claude-to-Codex and
Codex-to-Claude messaging through Markdown files, with acknowledgments, lifecycle status,
artifact metadata, and no automation required.

## 11. Companion Skill Installation

Install the Codex operating skill at:

```text
~/.codex/skills/agent-bus/SKILL.md
```

Install the Claude operating skill at:

```text
~/.claude/skills/agent-bus/SKILL.md
```

These skills tell each agent how to interpret Agent Bus messages. In particular, they
should not ask the user what to do with an actionable inbound message. They should
acknowledge, act, reply, mark read, and update thread status unless the task is unsafe,
impossible, or genuinely ambiguous.
