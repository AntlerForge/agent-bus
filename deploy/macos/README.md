# macOS bridge services

The example LaunchAgent files keep the native provider bridges alive across logins and
restart them after an unexpected exit. Replace `/Users/YOU` with the real home directory,
copy each file without the `.example` suffix into `~/Library/LaunchAgents/`, then load it
with `launchctl bootstrap gui/$(id -u) <plist-path>`.

All three examples use the A6 tunnel at `http://127.0.0.1:18091/agent-bus`. Install and
start `com.antlerforge.agent-bus-a6-tunnel` first. Runtime state belongs under
`~/Library/Application Support/Agent Bus/`; logs belong under
`~/var/log/home-platform/agent-bus/`. Neither location is a second message ledger.

The provider CLIs must already be authenticated for unattended use:

- Codex: `codex login`
- Cursor: `cursor-agent login`
- Antigravity: sign in to the desktop app once, then confirm `agy models` works

Use `npm run bridge:test -- --target codex --target cursor --target antigravity --artifact`
after loading the services. The command proves acknowledgement, same-thread response,
completion status and remote artifact handoff against the authoritative control plane.

## Health, restart policy and repair

`npm run bridge:doctor` checks every LaunchAgent, the tunnel, control-plane
reachability and heartbeat freshness, kickstarts an unhealthy tunnel, and prints the
exact repair command for anything else. If a bridge cannot be repaired, the correct
outcome is "manual handoff required, bridge down" — computer-use GUI driving of the
provider apps is never a fallback.

Restart policy audit (2026-08-11):

| LaunchAgent | Policy | Rationale |
| --- | --- | --- |
| `…-codex-bridge`, `…-cursor-bridge`, `…-antigravity-bridge` | `KeepAlive` + `RunAtLoad` + `ThrottleInterval 10` | Persistent daemons; crash → relaunch within ~10 s. |
| `…-a6-tunnel` | Same, plus `SoftResourceLimits NumberOfFiles 4096` / hard 8192 | launchd gives agents a 256-fd soft limit; ssh accepts one fd per forwarded connection, so bridge polling exhausted it (`accept: Too many open files`, exit 255, flapping). Network drops end the process (ServerAlive 30×3) and `KeepAlive` retries with launchd's built-in throttle backoff. |
| `…-outcome-reporter` | `StartCalendarInterval` every 15 min + `RunAtLoad`, no `KeepAlive` | Deliberately a short-lived scheduled job that publishes the read-only Mac snapshot to A6 and exits; "not running" between runs is by design. |
