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
