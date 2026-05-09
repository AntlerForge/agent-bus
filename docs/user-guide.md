# Agent Bus User Guide

## 1. Aim

Agent Bus is a local mailbox for collaboration between Claude and Codex on your Mac.

The goal is to let:

- you send work from one agent to the other without copy/paste;
- Claude and Codex exchange tasks, replies, status, and shared files;
- automatic responder sessions handle delegated tasks without you manually relaying every
  message;
- in-app chats still participate when you want a human-visible conversation.

Agent Bus deliberately keeps the transport simple. Messages are Markdown files under
`~/AgentBus`, and both agents access them through a local MCP server or
through the bridge processes.

## 2. Mental Model

Agent Bus routes to agent inboxes, not directly to proprietary app chat windows.

An agent ID is the address. Current default IDs are:

| Agent ID | Intended target | Delivery mode |
| --- | --- | --- |
| `codex` | Persistent Codex auto responder | Automatic when `src/codex-bridge.mjs` is running |
| `claude-code` | Claude Code auto responder | Automatic when Claude Code is started with `agent-bus-channel` |
| `claude` | Claude app or generic Claude chat | Manual: ask that chat to read the `claude` inbox |

You can create extra IDs for specific in-app chats, for example `claude-planning-chat` or
`codex-review-chat`. The chat is "connected" to that ID because you instruct that specific
chat to use `read_inbox(agent: "...")`. There is no current API that pushes a message into
an arbitrary existing Claude app or Codex app chat by hidden chat ID.

There are three separate setup ideas:

- **Tool access:** Claude and Codex app chats need the Agent Bus MCP server so they can
  send messages and manually read inboxes.
- **Automatic responders:** `claude-code` and `codex` need bridge processes running so
  messages can be handled without you manually checking an inbox.
- **Specific app-chat routing:** a visible app chat is bound to a custom inbox name only
  when you tell that exact chat to read that inbox.

The target name controls the route. For example, a Claude Cowork app chat can request an
automatic Codex reply by sending to `codex`. A Codex app chat can request an automatic
Claude reply by sending to `claude-code`.

## 3. Setup Sequence

Use this sequence for a new machine or a clean reset.

1. Confirm the project source exists:

```text
/path/to/agent-bus/
```

2. Confirm the runtime mailbox exists outside iCloud:

```text
~/AgentBus/
```

3. Register the main Agent Bus MCP server with Codex and Claude. This gives app chats and
CLI sessions the tools to send messages, read inboxes, reply, mark read, and update
thread status.

4. Register the Claude Code channel server. This is the extra bridge that lets Agent Bus
push messages into a running Claude Code session.

5. Start Claude Code with the Agent Bus channel enabled. This makes target `claude-code`
an automatic responder.

6. Start a normal Codex CLI chat if you want a separate manual Codex terminal chat.

7. Start the Codex bridge in a visible Terminal. This makes target `codex` an automatic
responder and opens the `agent-bus>` prompt into the same persistent Codex session.

8. For each visible app chat you want to target manually, choose a custom Agent Bus
address and paste the claim prompt into that exact chat.

After setup, normal operation is just target selection:

- target `codex` for automatic Codex bridge replies;
- target `claude-code` for automatic Claude Code replies;
- target a custom app-chat address for a manually handled visible app chat.

The exact commands and prompts for each step are in the sections below.

## 4. Capabilities

Agent Bus can:

- send new messages with sender, recipient, subject, body, priority, and flags;
- append replies to a durable thread;
- acknowledge receipt separately from completing the task;
- mark messages read;
- track thread status: `open`, `acknowledged`, `in_progress`, `input_required`, `blocked`,
  `completed`, `failed`, `canceled`, or `closed`;
- store large shared files in `~/AgentBus/shared`;
- list agents, threads, and artifacts;
- deliver messages automatically into Claude Code via a channel server;
- deliver messages automatically to a persistent Codex CLI responder via the Codex bridge;
- let you type directly into that persistent Codex responder from a visible Terminal window.

Current limitations:

- Claude app/Cowork and Codex app chats can use Agent Bus tools, but they are not
  automatically pushed messages unless the app exposes a channel mechanism.
- The Codex app chat itself is not the same as the Codex terminal bridge. The bridge is a
  persistent Codex CLI session with its own stored session context.
- The default Codex bridge listens to `codex`. If you want a specific Codex app chat to
  handle a task manually, use a different agent ID so the auto responder does not consume
  the message first.

## 5. Local Layout

Project source:

```text
/path/to/agent-bus/
```

Runtime mailbox:

```text
~/AgentBus/
  inbox/
    claude/
    claude-code/
    codex/
  threads/
  shared/
  archive/
  _agents.json
  _codex_bridge_session.json
```

Put shared files in:

```text
~/AgentBus/shared/
```

Then reference the absolute path in the message body or `artifact_paths`.

## 6. MCP Server Setup

### Codex App Or Codex CLI

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.agent-bus]
command = "node"
args = ["/path/to/agent-bus/src/server.mjs"]
```

Restart Codex or start a new Codex chat so the MCP server is discovered.

The Codex Agent Bus skill is installed at:

```text
~/.codex/skills/agent-bus/SKILL.md
```

In a Codex app chat, use wording like:

```text
Use the agent-bus skill. Read inbox agent codex-review-chat and handle anything actionable.
```

### Claude App / Cowork / Claude Code

Register the main Agent Bus MCP server:

```bash
claude mcp add --transport stdio --scope user --env AGENT_BUS_ROOT="$HOME/AgentBus" agent-bus -- node /path/to/agent-bus/src/server.mjs
```

Restart Claude Desktop / Cowork / Claude Code or start a new session so the tools are
loaded.

The Claude Agent Bus skill is installed at:

```text
~/.claude/skills/agent-bus/SKILL.md
```

In a Claude app chat, use wording like:

```text
Use the agent-bus skill. Read inbox agent claude-planning-chat and handle anything actionable.
```

## 7. Automatic Responder Setup

### Claude Code Auto Responder

Register the Claude channel server:

```bash
claude mcp add --transport stdio --scope user --env AGENT_BUS_ROOT="$HOME/AgentBus" agent-bus-channel -- node /path/to/agent-bus/src/claude-channel.mjs
```

Start Claude Code from the project folder with the channel enabled:

```bash
cd /path/to/agent-bus
claude --dangerously-load-development-channels server:agent-bus-channel
```

Messages addressed to `claude-code` with `requires_response: true` are pushed into that
running Claude Code session. Claude Code should then acknowledge, act, reply, mark read,
and update thread status through the normal `agent-bus` tools.

Advanced: the channel server defaults to `claude-code`. It can watch another Claude-side
agent ID by starting it with `AGENT_BUS_CHANNEL_AGENT=<agent-id>`.

### Normal Codex CLI Chat

This is the ordinary Codex CLI chat. It is useful when you want a normal interactive Codex
terminal session, separate from the bridge wrapper.

Start it from the project folder:

```bash
cd /path/to/agent-bus
codex -m gpt-5.2
```

This does not create the Agent Bus auto responder. It is just a normal Codex CLI chat. It
can use Agent Bus tools if the Codex MCP server is configured, and it can manually read a
named inbox if you give it an address in the prompt, but it does not watch `codex`
automatically.

### Codex Bridge Setup: Persistent Auto Responder For `codex`

The Codex bridge is the Codex-side automatic responder. It is the setup step that connects
Agent Bus target `codex` to a persistent Codex CLI session.

The bridge does four jobs:

- watches `~/AgentBus/inbox/codex`;
- creates or resumes one persistent Codex CLI session;
- injects inbound Agent Bus tasks into that same session;
- writes Codex's reply back to the Agent Bus thread.

Keep this Terminal window open while you want `codex` to auto reply.

Run this in a visible Terminal:

```bash
cd /path/to/agent-bus
node src/codex-bridge.mjs --model gpt-5.2
```

This does not open the normal full-screen Codex CLI chat UI. It starts the Agent Bus
bridge wrapper. The wrapper uses Codex CLI underneath, creates or resumes a persistent
Codex session, and gives you its own visible prompt:

```text
agent-bus>
```

That `agent-bus>` prompt is the user-facing chat for the bridge responder. Anything typed
there is sent into the same persistent Codex session that receives messages addressed to
`codex`.

The bridge:

- creates or resumes one Codex CLI session;
- stores the session ID in `~/AgentBus/_codex_bridge_session.json`;
- watches `~/AgentBus/inbox/codex`;
- handles unread `requires_response: true` messages addressed to `codex`;
- writes replies back to the sender;
- gives you a visible `agent-bus>` prompt into the same persistent Codex session.

Useful bridge commands:

```text
/session
/send claude-code | Subject | Body
/quit
```

Anything else typed at `agent-bus>` is sent to the same persistent Codex responder context
that Claude messages use.

Use `--new-session` to intentionally reset the Codex bridge context:

```bash
node src/codex-bridge.mjs --model gpt-5.2 --new-session
```

With the currently installed Codex CLI, `gpt-5.2` is the working default. Newer models can
be selected with `--model` after the local CLI supports them.

Useful bridge options:

```bash
node src/codex-bridge.mjs --model gpt-5.2
node src/codex-bridge.mjs --model gpt-5.2 --new-session
node src/codex-bridge.mjs --model gpt-5.2 --sandbox workspace-write
node src/codex-bridge.mjs --model gpt-5.2 --codex-command /path/to/codex
```

If you see:

```text
Agent Bus Codex bridge watching ~/AgentBus/inbox/codex
Persistent session: ...
agent-bus>
```

then the bridge is live and messages sent to `codex` can auto reply.

## 8. Targeting Messages

Use the `to` field to choose the target inbox.

### Target The Codex Auto Responder

Send to `codex`:

```json
{
  "from": "claude",
  "to": "codex",
  "subject": "Review implementation plan",
  "body": "Please review docs/implementation-and-test-plan.md and identify gaps.",
  "requires_response": true,
  "ack_required": true
}
```

This is picked up by the Codex bridge if it is running.

### Target The Claude Code Auto Responder

Send to `claude-code`:

```json
{
  "from": "codex",
  "to": "claude-code",
  "subject": "Check UX wording",
  "body": "Please review the proposed user guide wording and reply with concise edits.",
  "requires_response": true,
  "ack_required": true
}
```

This is pushed into the running Claude Code channel session if it is running.

From the Codex bridge terminal, the same idea is:

```text
/send claude-code | Check UX wording | Please review the proposed user guide wording and reply with concise edits.
```

### Target A Generic In-App Claude Chat

Send to `claude`:

```json
{
  "from": "codex",
  "to": "claude",
  "subject": "Question for Claude app",
  "body": "Please answer this from the Claude app chat context.",
  "requires_response": true
}
```

Then in the Claude app chat, ask:

```text
Use the agent-bus skill. Read inbox agent claude and handle actionable messages.
```

### Name, Connect, And Target A Specific In-App Chat

Naming an app chat means giving it an Agent Bus address inside that chat. Agent Bus does
not rename the proprietary Claude or Codex window, and it cannot discover a hidden chat
ID from the app. The address works because that exact chat keeps the instruction in its
conversation context and reads that named inbox when you ask it to.

Create a unique address for the chat. Use lowercase, hyphenated names that describe the
chat's role:

```text
claude-planning-chat
codex-review-chat
```

Optionally register the address so it appears in agent listings:

```json
{
  "agent_id": "claude-planning-chat",
  "display_name": "Claude Planning Chat",
  "type": "claude-desktop",
  "capabilities": ["planning", "writing", "review"]
}
```

Open the exact app chat you want to name, then paste a claim prompt.

For a Claude Cowork app chat:

```text
Use the agent-bus skill.
For this conversation, your Agent Bus address is claude-planning-chat.
When I ask you to check Agent Bus, read inbox agent claude-planning-chat, handle
actionable messages, reply in the same thread, mark messages read, and update thread
status.
Confirm the address you will use.
```

For a Codex app chat:

```text
Use the agent-bus skill.
For this conversation, your Agent Bus address is codex-review-chat.
When I ask you to check Agent Bus, read inbox agent codex-review-chat, handle actionable
messages, reply in the same thread, mark messages read, and update thread status.
Confirm the address you will use.
```

That is the binding step. From then on, send messages to that ID when you want that
visible chat to handle them:

```json
{
  "from": "codex",
  "to": "claude-planning-chat",
  "subject": "Planning question",
  "body": "Please evaluate these options using the context in this Claude app chat.",
  "requires_response": true
}
```

When you want the visible app chat to pick up waiting work, ask that same chat:

```text
Use the agent-bus skill. Read inbox agent claude-planning-chat and handle actionable messages.
```

This is the practical way to target a specific in-app chat. The target is the inbox ID, and
the specific chat becomes responsible for that inbox because you tell it to read that ID.
It is still manual: Agent Bus cannot push directly into arbitrary app-chat windows.

If you open a new app chat and want it to take over the same address, paste the same claim
prompt into the new chat. Avoid having two app chats read the same custom inbox unless you
deliberately want them to race for the same work.

## 9. Common Workflows

### Workflow A: Claude Code Tasks Codex Auto Responder

1. Start the Codex bridge.
2. In Claude Code, send a message to `codex` with `requires_response: true`.
3. The bridge acknowledges the message.
4. The persistent Codex responder handles the task using its session context.
5. The bridge replies in the same thread and marks the inbound message read.
6. Claude Code reads the reply.

### Workflow B: Codex Bridge Tasks Claude Code Auto Responder

1. Start Claude Code with `agent-bus-channel`.
2. Start the Codex bridge.
3. At `agent-bus>`, run:

```text
/send claude-code | Smoke test | Please confirm you received this through Agent Bus.
```

4. Claude Code receives the message in its active session.
5. Claude Code replies through Agent Bus.

### Workflow C: Codex App Chat Uses Agent Bus Manually

1. Open the Codex app chat.
2. Make sure the `agent-bus` MCP server is available.
3. Ask Codex to use the `agent-bus` skill.
4. Ask it to send a message or read a specific inbox.

Example:

```text
Use the agent-bus skill. Send Claude Code a task asking it to review docs/user-guide.md.
Target claude-code and require a response.
```

### Workflow D: Claude App Chat Uses Agent Bus Manually

1. Open the Claude app chat.
2. Make sure the `agent-bus` MCP server is available.
3. Ask Claude to use the Agent Bus skill.
4. Ask it to send a message to `codex`, `claude-code`, or a custom inbox.

Example:

```text
Use the agent-bus skill. Send Codex a task to run the test suite and report failures.
Target codex and require a response.
```

### Workflow E: Share A File

1. Put the file under `~/AgentBus/shared`.
2. Send a message referencing the absolute path.
3. Include the path in `artifact_paths` when using the MCP tool directly.

Example body:

```text
Please review this draft:
~/AgentBus/shared/draft-user-guide.md
```

## 10. Message Flags

Use `requires_response: true` when the target should act and reply.

Use `ack_required: true` when you want confirmation that the message was received.

Use `requires_response: false` for FYI messages, receipts, or final replies. This avoids
infinite loops where both agents keep replying to each other.

Replies should normally set:

```json
{
  "requires_response": false
}
```

Set `requires_response: true` on a reply only when assigning a new task or asking a new
question.

## 11. Inspecting State

Read the files directly:

```text
~/AgentBus/inbox/<agent-id>/
~/AgentBus/threads/
~/AgentBus/shared/
```

Or ask an agent with the MCP tools to run:

- `list_agents`
- `list_threads`
- `read_inbox`
- `list_artifacts`

For the Codex bridge session:

```text
~/AgentBus/_codex_bridge_session.json
```

Inside the bridge terminal:

```text
/session
```

## 12. Troubleshooting

If a message is not handled automatically:

- confirm the target is correct: `codex` for Codex bridge, `claude-code` for Claude Code
  channel;
- confirm `requires_response: true`;
- confirm the relevant bridge/session is running;
- confirm the app or CLI was restarted after MCP registration;
- check `~/AgentBus/inbox/<agent-id>/`;
- check `list_threads` for status;
- avoid running two responders against the same inbox unless you deliberately want a race.

If Claude Code does not receive channel messages:

- confirm `agent-bus-channel` is registered;
- start Claude Code with:

```bash
claude --dangerously-load-development-channels server:agent-bus-channel
```

If Codex bridge fails to start with a model error:

- use `--model gpt-5.2`;
- upgrade Codex CLI before using newer models.

If you want a clean Codex bridge context:

```bash
node src/codex-bridge.mjs --model gpt-5.2 --new-session
```

## 13. Safety Notes

Agent Bus messages are local Markdown files. Do not put secrets, credentials, private
keys, or access tokens in messages or shared artifacts.

The Claude Code channel uses an experimental channel mechanism and warns about prompt
injection risk. Treat messages from agents as instructions only when you trust the local
source and the requested action is appropriate.

For destructive tasks, the receiving agent should ask for user confirmation rather than
acting automatically.
