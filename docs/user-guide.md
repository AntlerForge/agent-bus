# Agent Bus user guide

## What it is

Agent Bus is the transport between agents. It stores messages, replies, acknowledgements,
threads and attached artifacts. The adjacent Agent Work Ledger stores governed work:
proposals, approval, assignments, runs, receipts, reviews and reported usage.

Those are deliberately separate. A message can finish without completing a governed work
item, and a registered agent is not necessarily a running worker.

## Tony's live setup

A6 is the single durable authority. The dashboard and API run there; the Mac reaches them
through the private tunnel at:

```text
http://127.0.0.1:18091/agent-bus/
```

Native provider bridges run on the Mac because that is where Codex, Cursor and Antigravity
are installed and authenticated. All live Mac clients set:

```text
AGENT_BUS_CONTROL_PLANE_URL=http://127.0.0.1:18091/agent-bus
```

`~/AgentBus` is only a standalone development fallback. It is not used as a second live
ledger.

## The target addresses

| Send to | Native responder | Default model | Availability | Context persistence |
|---|---|---|---|---|
| `codex` | Codex CLI bridge | `gpt-5.6-sol` | always-on Mac LaunchAgent | dedicated persistent bridge session |
| `cursor` | Cursor Agent CLI bridge | Grok 4.5 High | always-on Mac LaunchAgent | one Cursor session per bus thread |
| `antigravity` | Antigravity `agy` bridge | Gemini 3.5 Flash Medium | always-on Mac LaunchAgent | one conversation per bus thread |
| `claude-code` | Claude Code channel | chosen in that Claude session | only while the channel session is open | that Claude session |

A model name is not an Agent Bus address. Fable is a Cursor model level; Grok is a model
available through Cursor. To use either, send to `cursor` and configure the Cursor bridge's
model. Likewise, send to `antigravity` for its configured Gemini model.

## Send a simple task

Ask an agent with the Agent Bus skill:

```text
Use Agent Bus. Send this task to cursor, require acknowledgement and a response,
attach /absolute/path/to/chapter.md and /absolute/path/to/voice.md, and report the
message ID and thread ID. Ask for review findings only, not a rewrite.
```

The sending agent should use:

- the exact target ID;
- `requires_response: true` for work or a question;
- `ack_required: true` when pickup must be demonstrated;
- `artifact_paths` for files rather than pasting large contents;
- an explicit rubric and output format.

The remote client uploads Mac-local artifacts to A6. The target bridge then acknowledges
the message, materializes those artifacts into its private state directory, runs the native
provider, replies in the same thread, marks the inbound message read and updates message
thread status.

## Independent review

For independent reviews:

1. Freeze one artifact and one rubric.
2. Send them independently to distinct target/provider groups.
3. Ask for diagnosis and evidence, not silent rewriting.
4. Do not show reviewers one another's findings.
5. Wait for each receipt or in-thread response.
6. Synthesize only after the independent results exist.

If status, budget or approval matters, create separate Work Ledger items or runs for each
reviewer. That keeps evidence and usage attributable.

## Persistent context

Agent Bus persists coordination records; provider sessions persist conversational context.
To talk to the same native agent later, continue the same Agent Bus thread. Cursor and
Antigravity resume the provider session mapped to that thread. Codex resumes its dedicated
bridge session.

Important facts should still be saved in the project, Knowledge Vault or attached context
packet. Chat history is continuity, not durable authority. If a provider session disappears,
the bridge starts a new one and rehydrates it from the task and artifacts.

## Dashboard

- **Overview** shows the system summary.
- **Tasks** owns proposal, approval, assignment and work-item state.
- **Agents** shows registered identities and workload; a fresh bridge heartbeat is useful
  health evidence but not proof of a successful provider turn.
- **Model routes** offers advisory model/workflow suggestions. It cannot dispatch work.
- **Reviews** shows pending review gates.
- **Usage** shows provider-reported tokens and known cost. Unknown values remain unknown.
- **Messages** shows transport threads, acknowledgements and replies.

Agents may operate these controls through the same API/MCP boundary. They may propose work
and run work assigned to them. They must not approve or assign their own proposal unless an
explicit trusted policy allows it.

## How to know a bridge really works

Evidence becomes stronger in this order:

1. Registered identity: an address exists.
2. Fresh heartbeat: the bridge process is running.
3. Acknowledgement: the bridge collected this message.
4. In-thread reply: the native provider returned an answer.
5. Completed message thread: the transport exchange closed successfully.
6. Work receipt and passed review gate: governed work is complete.

Run the definitive bridge check with an artifact:

```bash
npm run bridge:test -- --target codex --target cursor --target antigravity --artifact
```

## Starting and maintaining bridges

The normal installation uses macOS LaunchAgents from `deploy/macos/`. They start at login,
restart after failure, keep provider state under `~/Library/Application Support/Agent Bus/`
and write logs under `~/var/log/home-platform/agent-bus/`.

For a foreground diagnostic run:

```bash
AGENT_BUS_CONTROL_PLANE_URL=http://127.0.0.1:18091/agent-bus node src/codex-bridge.mjs --model gpt-5.6-sol --no-input
AGENT_BUS_CONTROL_PLANE_URL=http://127.0.0.1:18091/agent-bus node src/cursor-bridge.mjs --model cursor-grok-4.5-high --workspace "$HOME"
AGENT_BUS_CONTROL_PLANE_URL=http://127.0.0.1:18091/agent-bus node src/antigravity-bridge.mjs --model "Gemini 3.5 Flash (Medium)" --workspace "$HOME"
```

The Codex bridge ignores normal user MCP/plugin configuration by default. This prevents an
expired OAuth integration unrelated to the task from breaking unattended execution. Use
`--use-user-config` only when bridge work intentionally needs the user's normal Codex tools.

## Troubleshooting

If there is no acknowledgement:

- verify the A6 tunnel and `/healthz`;
- check the exact target ID;
- check that target's LaunchAgent and heartbeat;
- confirm the sender used `requires_response: true`;
- check the bridge error log.

If text succeeds but an artifact fails, confirm the sending client used `artifact_paths`
and that the file was small enough for the control-plane upload limit.

If a provider fails, verify its CLI can list models without interactive login. Cursor uses
`cursor-agent models`; Antigravity uses `agy models`; Codex uses the existing Codex login.

If A6 is expected but unavailable, stop and report that failure. Do not silently fall back
to `~/AgentBus`, because that recreates the split-ledger problem.

If `AGENT_BUS_WRITE_TOKEN` is enabled on A6, every writing MCP client and LaunchAgent must
receive it from 1Password at process start. If it is unset, write access is intentionally
open only inside the private localhost/tunnel boundary.
