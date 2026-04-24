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
- a thread ID;
- sender;
- recipient;
- status;
- created timestamp;
- optional subject;
- body text in Markdown;
- optional references to shared files.

Messages should be human-readable without running the MCP server.

## 8. Thread Requirements

Thread files shall preserve the conversation history between agents.

A thread should show:

- the thread ID;
- subject or title;
- participants;
- chronological messages;
- references to shared files where relevant.

## 9. Shared Artifact Requirements

The `shared/` directory shall be used for files that are too large, structured, or awkward
to embed directly in a message.

Agents shall reference shared artifacts by absolute path in their messages.

The system shall not delete shared artifacts automatically in the first version.

## 10. Tool Requirements

The first MCP server should expose these tools:

- `send_message(to, subject, body, thread_id?)`
- `read_inbox(agent)`
- `reply(thread_id, body)`
- `mark_read(message_id)`
- `list_threads()`

The tool interface should hide file mechanics from the agents but leave the files readable
to the user.

## 11. Initiation Requirements

The first version shall support manual initiation:

- the user tells Claude or Codex to send a message;
- the user tells the other agent to check its inbox.

Later versions should support automated initiation:

- Claude-side hooks or channels where available;
- Codex-side automation, polling, or CLI invocation;
- a local watcher process if simple polling is insufficient.

## 12. Reliability Requirements

The system shall:

- avoid overwriting unread messages;
- avoid corrupting thread files during normal use;
- handle missing inbox folders by creating them or reporting a clear error;
- keep enough metadata to recover from partial failure manually;
- prefer append-only thread history where practical.

## 13. Security and Safety Requirements

The first version shall:

- run locally;
- store data in local user-owned folders;
- avoid executing message content as commands;
- treat shared files as data unless explicitly instructed by the user;
- avoid storing secrets in messages where possible.

## 14. Success Criteria

The first usable version is successful when:

- Claude can send a Markdown-backed message to Codex;
- Codex can read that message and reply;
- Claude can read the reply;
- a shared file can be referenced in a message and found by the receiving agent;
- all generated files are understandable by opening them directly in Finder or an editor.
