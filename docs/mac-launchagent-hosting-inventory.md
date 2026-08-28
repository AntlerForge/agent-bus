# Mac LaunchAgent hosting inventory

Reviewed 2026-08-28 against the rule: a job remains Mac-only only when it needs
macOS/TCC, a local app/runtime, a local working tree or mount, or a Mac-side
tunnel/bridge. This inventory records hosting verdicts; it does not convert any
LOAD-BEARING job.

| LaunchAgent | Verdict | Reason |
|---|---|---|
| a6-share-mount | must be Mac | Owns the local SMB mount. |
| agent-bus-a6-tunnel | must be Mac | Provides the Mac localhost edge; now part of liveness/reconciliation. |
| agent-bus-antigravity-bridge | must be Mac | Resumes a Mac-hosted provider runtime. |
| agent-bus-codex-bridge | must be Mac | Resumes the local Codex session. |
| agent-bus-cursor-bridge | must be Mac | Resumes the local Cursor session. |
| agent-bus-outcome-reporter | must be Mac | Reads interactive state, mount state and LaunchAgents. |
| buzz-a6-tunnel | must be Mac | Mac localhost access tunnel. |
| estate-startup | must be Mac | Opens the Mac estate desk after login. |
| estate-status | must be Mac | Projects local startup/control state. |
| kv-developer-mirrors-sync | must be Mac | Reads local developer working copies. |
| kv-mac-runtime-check | must be Mac | Reads macOS apps/TCC bridges. |
| kv-project-store-sync | must be Mac, LOAD-BEARING | Existing application bridge; no conversion made. |
| kv-vault-mirror-sync | must be Mac | Maintains the emergency/offline Mac mirror. |
| pbv-a6-sync | must be Mac, LOAD-BEARING | Reads local PBV app data; no conversion made. |
| pbv-bonjour | must be Mac | Advertises the local PBV endpoint. |
| pbv-ingest-server | must be Mac | Receives local/iPhone app traffic. |
| porthole-host | must be Mac | Hosts the local Mac control surface. |
| porthole-web-tunnel | must be Mac | Tunnels the Mac-hosted control surface. |
| replica-parity-sentinel | must be Mac | Compares Mac working copies with A6 replicas. |
| whoop-daily | A6 candidate, LOAD-BEARING decision pending | Pure API pull, but no conversion or disablement without Tony's named decision. |

The GFG sweep is not a LaunchAgent. Its hosting choice remains a separate Tony
decision; the watchdog now records `mac_offline` and return reconciliation owns
catch-up meanwhile.
