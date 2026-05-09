#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_BUS_ROOT="$HOME/AgentBus"
BUS_ROOT="${AGENT_BUS_ROOT:-$DEFAULT_BUS_ROOT}"
BUS_ROOT="${BUS_ROOT/#\~/$HOME}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node 20+ and run setup again." >&2
  exit 1
fi

if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo "Installing npm dependencies..."
  (cd "$ROOT_DIR" && npm install)
fi

mkdir -p \
  "$BUS_ROOT/inbox/claude" \
  "$BUS_ROOT/inbox/claude-code" \
  "$BUS_ROOT/inbox/codex" \
  "$BUS_ROOT/threads" \
  "$BUS_ROOT/shared" \
  "$BUS_ROOT/archive"

cat > "$ROOT_DIR/.agent-bus.local.json" <<EOF
{
  "agentBusRoot": "$BUS_ROOT",
  "projectRoot": "$ROOT_DIR"
}
EOF

echo
echo "Agent Bus setup complete."
echo
echo "Project root:"
echo "  $ROOT_DIR"
echo
echo "Runtime mailbox:"
echo "  $BUS_ROOT"
echo
echo "Codex MCP config (~/.codex/config.toml):"
cat <<EOF
[mcp_servers.agent-bus]
command = "node"
args = ["$ROOT_DIR/src/server.mjs"]
env = { AGENT_BUS_ROOT = "$BUS_ROOT" }
EOF
echo
echo "Claude MCP command:"
echo "  claude mcp add --transport stdio --scope user --env AGENT_BUS_ROOT=\"$BUS_ROOT\" agent-bus -- node \"$ROOT_DIR/src/server.mjs\""
echo
echo "Claude Code channel command:"
echo "  claude mcp add --transport stdio --scope user --env AGENT_BUS_ROOT=\"$BUS_ROOT\" agent-bus-channel -- node \"$ROOT_DIR/src/claude-channel.mjs\""
echo
echo "Codex bridge:"
echo "  AGENT_BUS_ROOT=\"$BUS_ROOT\" node \"$ROOT_DIR/src/codex-bridge.mjs\" --model \${AGENT_BUS_CODEX_MODEL:-gpt-5.2}"
echo
echo "Shared files go in:"
echo "  $BUS_ROOT/shared"
echo
echo "Important: grant both agents access to the project folder and the runtime mailbox folder."
