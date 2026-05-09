---
name: agent-bus
description: Use when Claude needs to communicate with Codex through the local Agent Bus mailbox, check or process Agent Bus inbox messages, send tasks or replies to Codex, acknowledge messages, update Agent Bus thread status, or operate as the Claude side of the Claude-Codex collaboration loop.
---

# Agent Bus

Use Agent Bus as a durable mailbox between Claude and Codex.

## Paths

- Project: detect from the current workspace or ask the user for the cloned repo path.
- Runtime mailbox: use `AGENT_BUS_ROOT` when set, otherwise `~/AgentBus`.
- Claude inbox: `<runtime>/inbox/claude`
- Codex inbox: `<runtime>/inbox/codex`
- Shared artifacts: `<runtime>/shared`

## Setup Assistant

When the user asks to set up Agent Bus:

1. Locate the repo root. Prefer the current workspace if it contains `src/server.mjs`.
2. Run `./setup.sh` from the repo root if available.
3. Confirm the runtime mailbox exists and contains `inbox/`, `threads/`, `shared/`, and
   `archive/`.
4. Check that Claude can read and write the runtime `shared/` directory.
5. Provide the exact Claude MCP registration commands printed by setup.
6. Tell the user that Codex must also be granted access to both the repo folder and the
   runtime mailbox folder.
7. If shared-file handoff fails, stop and explain which folder is inaccessible instead of
   trying random temporary paths.

## Core Behavior

When asked to use Agent Bus, do the work through the `agent-bus` MCP tools when available.
If the MCP tools are not available, say so and use the readable Markdown mailbox only if
the user asks for a fallback.

Agent Bus channel events arrive in Claude Code as `<channel source="agent-bus-channel" ...>`.
Treat those events exactly like actionable inbound Agent Bus messages. Do not ask the user
whether to answer them.

Do not ask the user whether to answer an actionable inbound Agent Bus message. Treat the
message as a delegated task from Codex unless it is unsafe, impossible, or genuinely
ambiguous.

For an inbound message addressed to `claude`:

1. Read the message body and thread context.
2. Acknowledge the message with `ack_message`.
3. If `requires_response` is true, act on the task using the current Claude conversation
   context plus any referenced files.
4. Send a reply to Codex with `reply`.
5. Mark the inbound message read with `mark_read`.
6. Update the thread status to `completed`, `input_required`, `blocked`, or `failed`.
7. Briefly report in the visible Claude chat what was received and how it was handled.

If `requires_response` is false, do not create a new substantive reply unless the user
explicitly asks. Acknowledge or mark read only when appropriate.

## Sending Messages To Codex

When the user asks Claude to ask, task, consult, check with, or send something to Codex:

1. Put large artifacts in the runtime `shared/` directory.
2. Send the message to `codex` with `send_message`.
3. Set `from: claude` and `to: codex`.
4. Set `requires_response: true` for questions, review requests, or delegated work.
5. Set `ack_required: true` when the user needs to know Codex received it.
6. Use `requires_response: false` for FYI/status messages.
7. Report the `message_id` and `thread_id` to the user.

## Reply Discipline

Avoid infinite loops.

- Default replies to `requires_response: false`.
- Set `requires_response: true` on a reply only when assigning a new task or asking a
  new question that Codex should answer.
- Do not reply to a pure acknowledgment with another acknowledgment.
- Do not reopen a `completed`, `failed`, `canceled`, or `closed` thread unless the user
  explicitly asks.

## When To Ask The User

Ask the user only when:

- the requested action is destructive or high-risk;
- required context or permissions are missing;
- the message asks for a policy, preference, or judgment only the user can make;
- acting would likely start an uncontrolled loop;
- the Agent Bus state is inconsistent or corrupted.

Otherwise, act.
