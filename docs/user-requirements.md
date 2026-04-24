# Agent Bus User Requirements

## 1. Purpose

Agent Bus shall provide a simple local mechanism for Claude and Codex to exchange tasks,
responses, and supporting files while each continues to run in its own normal agentic
harness on macOS.

The system is intended to avoid fragile UI automation and avoid putting active Git project
folders in iCloud. It should be inspectable, recoverable, and understandable through plain
files.

## 2. Users

Primary user:

- Tony, using Claude and Codex on macOS.

Participating agents:

- Claude, normally running in Claude Code or Claude Desktop-compatible workflows.
- Codex, normally running in the Codex desktop app or Codex CLI-compatible workflows.

## 3. High-Level Goals

Agent Bus shall:

- allow Claude to send a task or question to Codex;
- allow Codex to send a task or question to Claude;
- allow either agent to read pending messages addressed to it;
- allow either agent to reply in the same conversation thread;
- allow messages to be acknowledged separately from being answered;
- track the lifecycle of delegated work, not just message delivery;
- maintain a lightweight registry of known agents and their capabilities;
- support shared artifacts such as logs, screenshots, documents, patches, and JSON files;
- store messages and threads as Markdown so the user can inspect and recover them manually;
- keep runtime mailbox data outside iCloud;
- keep project source in a local Git repository under `~/Developer/personal/`;
- support later automation without requiring it for the first working version.

## 4. Non-Goals

The first version shall not:

- attempt to merge Claude and Codex into one shared live chat window;
- depend on AppleScript, Accessibility scripting, or foreground UI automation;
- require a cloud database;
- require both agents to be online at the same time;
- implement complex routing, permissions, or multi-user identity;
- automatically execute arbitrary shared files.

## 5. User Experience

The user should be able to ask one agent to contact the other in plain language.

Example Claude request:

```text
Use Agent Bus to ask Codex to review this implementation plan. Attach the draft in shared.
```

Example Codex request:

```text
Check your Agent Bus inbox. If Claude has sent a task, answer it and mark it read.
```

The system should make the file paths clear when artifacts are involved. For example:

```text
Please review:
/Users/antonybarfoot/AgentBus/shared/mcp-design-draft.md
```

## 6. Local Storage Requirements

Runtime data shall be stored at:

```text
/Users/antonybarfoot/AgentBus/
  inbox/
    claude/
    codex/
  threads/
  shared/
  archive/
```

Project source shall be stored at:

```text
/Users/antonybarfoot/Developer/personal/agent-bus/
```

The GitHub repository shall be:

```text
https://github.com/AntlerForge/agent-bus
```

## 7. Message Requirements

Each message shall include:

- a unique message ID;
- a monotonically increasing sequence number or equivalent cursor within its thread;
- a thread ID;
- sender;
- recipient;
- status;
- created timestamp;
- optional subject;
- optional priority or importance;
- optional acknowledgment requirement;
- body text in Markdown;
- optional references to shared files.

Messages should be human-readable without running the MCP server.

Message creation should be idempotent where practical. If an agent retries the same send
operation after a timeout, the system should avoid creating duplicate messages when the
caller supplied an idempotency key.

## 8. Thread Requirements

Thread files shall preserve the conversation history between agents.

A thread should show:

- the thread ID;
- subject or title;
- participants;
- lifecycle state;
- chronological messages;
- references to shared files where relevant.

Thread lifecycle states should be simple and explicit. The initial set should support:

- `open`
- `acknowledged`
- `in_progress`
- `input_required`
- `blocked`
- `completed`
- `failed`
- `canceled`
- `closed`

Terminal states should not be silently restarted. Follow-up work should create a new task
or continue in the same broader context with a clear reference to the previous thread.

## 9. Shared Artifact Requirements

The `shared/` directory shall be used for files that are too large, structured, or awkward
to embed directly in a message.

Agents shall reference shared artifacts by absolute path in their messages.

The system shall not delete shared artifacts automatically in the first version.

Shared artifacts should have enough metadata to make later handoffs unambiguous:

- artifact ID;
- file path;
- filename;
- MIME type or kind where known;
- producer;
- created timestamp;
- optional relationship to a message or thread;
- optional checksum.

If a shared artifact is revised, the revised artifact should be linked to the prior version
rather than overwriting history silently.

## 10. Agent Identity and Capability Requirements

The system shall maintain a small local registry of known agents.

Each registered agent should have:

- agent ID;
- display name;
- type or runtime, for example `claude-code`, `claude-desktop`, `codex`, or `codex-cli`;
- optional model or version label;
- optional capability notes;
- last-seen timestamp.

The first version may use static agent records for `claude` and `codex`, but the data model
should not prevent adding more agents later.

## 11. Tool Requirements

The first MCP server should expose these tools:

- `send_message(to, subject, body, thread_id?)`
- `read_inbox(agent)`
- `reply(thread_id, body)`
- `mark_read(message_id)`
- `list_threads()`
- `ack_message(message_id)`
- `update_thread_status(thread_id, status)`
- `register_agent(agent_id, display_name, capabilities?)`

The tool interface should hide file mechanics from the agents but leave the files readable
to the user.

## 12. Initiation Requirements

The first version shall support manual initiation:

- the user tells Claude or Codex to send a message;
- the user tells the other agent to check its inbox.

Later versions should support automated initiation:

- Claude-side hooks or channels where available;
- Codex-side automation, polling, or CLI invocation;
- a local watcher process if simple polling is insufficient.

Polling-based initiation should support a cursor or `since` value so agents can resume
without rereading or reprocessing the same messages.

## 13. Operator Visibility Requirements

The user should have a simple way to inspect the system state without asking either agent.

The first version may satisfy this with a CLI command or readable files. It should show:

- unread messages by recipient;
- active threads and their statuses;
- recent messages;
- known agents and last-seen timestamps;
- shared artifact references.

## 14. Reliability Requirements

The system shall:

- avoid overwriting unread messages;
- avoid corrupting thread files during normal use;
- handle missing inbox folders by creating them or reporting a clear error;
- keep enough metadata to recover from partial failure manually;
- prefer append-only thread history where practical.
- use atomic writes or equivalent safeguards for message and thread file updates;
- avoid duplicate processing during polling or retry;
- preserve an audit trail for status changes and message edits.

## 15. Security and Safety Requirements

The first version shall:

- run locally;
- store data in local user-owned folders;
- avoid executing message content as commands;
- treat shared files as data unless explicitly instructed by the user;
- avoid storing secrets in messages where possible.
- restrict file operations to the configured Agent Bus root unless the user explicitly
  authorises another path;
- validate paths to prevent traversal outside allowed roots;
- warn or block when messages appear to contain secrets, credentials, or private tokens;
- make it clear when a message asks an agent to modify code, run commands, or use external
  services.

## 16. Future Coordination Requirements

If Agent Bus is later used with multiple coding agents working in the same repository, it
should support advisory file reservations.

Reservations should include:

- reserving agent;
- file path or glob pattern;
- reason;
- thread ID;
- created timestamp;
- expiry timestamp.

Reservations should be advisory in the first version and should expire automatically to
avoid stale locks.

## 17. Success Criteria

The first usable version is successful when:

- Claude can send a Markdown-backed message to Codex;
- Codex can read that message and reply;
- Claude can read the reply;
- either agent can acknowledge receipt before producing a full answer;
- a task can move from open to completed or failed;
- a shared file can be referenced in a message and found by the receiving agent;
- repeated inbox polling does not process the same message twice;
- all generated files are understandable by opening them directly in Finder or an editor.
