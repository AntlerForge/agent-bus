# Agent Bus write-token cutover inventory

This is a retrospective inventory, added in repair commit `4062355` at 13:42
BST on 2026-08-23. It did not predate authentication enforcement. Enforcement
landed first in `594bc77` at 09:31 BST; missed writers, including the Claude-seat
MCP process and both AMB installations, then returned HTTP 401 through the
morning until the estate-wide writer repair. Token values are never recorded
here.

| Writer class | Write path | Runtime/configuration | Token source | Cutover obligation |
|---|---|---|---|---|
| Harness MCP servers (Claude, Codex, Cursor) | Agent Bus, Work Ledger and selector MCP tools via `src/server.mjs` | `~/.claude.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json` | `AGENT_BUS_WRITE_TOKEN_FILE`, or the default `~/.config/agent-bus/write-token.env` | Stop stale MCP children; prove a newly spawned MCP write. |
| Persistent provider bridges (Codex, Cursor, Antigravity) | Heartbeats, inbox acknowledgements, replies and artifacts via `src/remote-bus.mjs` | `~/Library/LaunchAgents/com.antlerforge.agent-bus-*-bridge.plist` | Default owner-only token file through `src/write-token.mjs` | Restart any bridge exhibiting 401s; verify every running process has the token-file setting and a fresh authenticated heartbeat. |
| Claude channel bridge | Channel acknowledgements and replies via `src/claude-channel.mjs` | Claude MCP/channel configuration | Default owner-only token file through `src/write-token.mjs` | New process must use the current source and token. |
| Browser dashboard | Work, agent lifecycle, message and review POSTs | `src/control-plane/public/app.js`, token injected by `src/control-plane/server.mjs` | Control-plane process environment | Prove authenticated dashboard-class POST while GET remains public. |
| AMB CLI | Passive AMB registration, notes, reads and retire operations | Mac `~/.local/bin/amb`; A6 `/usr/local/bin/amb` | `AMB_TOKEN`, `AGENT_BUS_WRITE_TOKEN`, or the default owner-only token file | Deploy both hosts; prove passive writes on both; remove stale shared fallback identities. |
| Estate Monitor | Incident dispatch to Agent Bus | `/usr/local/libexec/estate-monitor`, `/etc/estate-monitor/config.json`, systemd drop-in | `/home/ajbarfoot/.config/agent-bus/write-token.env` | Confirm running process carries the EnvironmentFile and prove authenticated dispatch transport. |
| Outcome Truth / deadman | Incident and deadman dispatch via `src/estate-steward/dispatch.mjs` | A6 systemd units and timers | Default owner-only token file through `src/write-token.mjs` | Prove a non-notifying authenticated transport check; scheduled run retains token access. |
| Decision queue | Governed status generation; no current control-plane mutation | A6 systemd unit | Existing environment file | Inventory as already-running/scheduled; no token write proof required while read-only. |
| HA approval listener | Writes local approval response files only | A6 systemd service | None for Agent Bus | Inventory as already running but not an HTTP writer. |
| Bridge round-trip diagnostic | Agent Bus send/reply diagnostic | `scripts/bridge-roundtrip.mjs` | Shared token loader | Remove direct environment-only assumption and prove the diagnostic. |
| Control-plane container | Enforces every HTTP mutation | A6 Docker Compose `compose.yaml` | A6 owner-only token file passed as `env_file` | Keep enforcement enabled; unauthenticated POST must return 401. |

Pre-change process inventory found 33 Mac `src/server.mjs` MCP children, including
processes dating from 2026-08-21 and therefore predating token-file support.
Already-running cutover targets are the three persistent Mac provider bridges,
all stale/current MCP children, the A6 control-plane container, Estate Monitor,
and the HA approval listener. Scheduled A6 outcome/deadman jobs are included in
the post-cutover checks even when inactive at capture time.

The actual rollout order was enforcement first, followed hours later by writer
repair and retrospective inventory. It was neither writers-first nor a planned,
documented brief cutover; the resulting morning-long 401 outage is a deviation
from that acceptance criterion.

Rollback is fail-closed and coordinated: restore the previous control-plane
binary/configuration and writer configurations in the same maintenance window.
Under ADR-0019, `startControlPlane` refuses to start without a token, so merely
unsetting the environment variable does not restore open writes. That differs
from the original acceptance criterion's rollback wording and is deliberate:
removing authentication must not silently reopen the write API.
