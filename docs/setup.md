# Agent Bus setup

There are two valid modes. Choose one authority and point every client at it.

## A6 deployment

Tony's live authority is the control plane on A6. The Mac reaches it through the private
SSH tunnel at `http://127.0.0.1:18091/agent-bus`. Do not use `~/AgentBus` for live work.

Every Mac-hosted MCP server, channel and bridge needs:

```text
AGENT_BUS_CONTROL_PLANE_URL=http://127.0.0.1:18091/agent-bus
```

The automatic targets are separate native workers:

| Target ID | Native surface | Default model | Context persistence |
|---|---|---|---|
| `codex` | Codex CLI | `gpt-5.6-sol` | dedicated persistent bridge session |
| `cursor` | Cursor Agent CLI | `cursor-grok-4.5-high` | one Cursor session per bus thread |
| `antigravity` | Antigravity `agy` CLI | Gemini 3.5 Flash Medium | one conversation per bus thread |
| `claude-code` | Claude Code channel | session-selected | only while that channel session is open |

Install the provider CLIs, authenticate them once and confirm their model-list commands
work. Then install the four LaunchAgent examples from `deploy/macos/`: the A6 tunnel plus
the Codex, Cursor and Antigravity bridges. They run at login and restart after failure.

Provider session maps are stored under `~/Library/Application Support/Agent Bus/`. Logs
are stored under `~/var/log/home-platform/agent-bus/`. Neither is a message ledger.

Test all automatic bridges, including remote artifact handoff:

```bash
npm run bridge:test -- --target codex --target cursor --target antigravity --artifact
```

Success means each target acknowledged the assignment, read the uploaded artifact, replied
on the original thread and set that message thread to `completed`.

## Standalone local development

For a self-contained development instance, run:

```bash
./setup.sh
npm test
```

This creates a local runtime at `~/AgentBus`. Configure participating MCP servers with
`AGENT_BUS_ROOT=$HOME/AgentBus`. Both agents need access to the project folder and runtime
folder, including `shared/` for artifacts.

Do not combine local and A6 mode. When `AGENT_BUS_CONTROL_PLANE_URL` is set, message,
thread, agent, artifact and Work Ledger operations use the remote control plane and should
not create a local fallback ledger.

## Tasking a bridge

Send to one of the exact target IDs above. Set `requires_response: true` for delegated
work and `ack_required: true` when receipt matters. Attach local files through
`artifact_paths`; the remote client uploads them to A6 before delivery.

The bridge performs the mechanical lifecycle: acknowledge, run the provider, reply in the
same thread, mark the inbound message read and update transport status. For governed work,
create and assign a Work Ledger item separately; message status is not task status.

Registration or a green heartbeat is useful but is not proof of successful execution. The
round-trip test—or a real acknowledgement and reply—is the definitive check.

## Write authentication

`AGENT_BUS_WRITE_TOKEN` is optional. If A6 enables it, every writing MCP client and bridge
must receive the token at process start from 1Password. If it is unset, write endpoints are
open only inside the private localhost/tunnel boundary; they must never be exposed directly
on a public interface.
