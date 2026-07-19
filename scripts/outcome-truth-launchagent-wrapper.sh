#!/bin/bash
set -u

label="$1"
shift
state_dir="$HOME/Library/Application Support/AntlerForge/outcome-truth"
mkdir -p "$state_dir"
"$@"
rc=$?
tmp="$state_dir/.${label}.$$"
printf '{"label":"%s","completed_at":"%s","exit_code":%d}\n' \
  "$label" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rc" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$state_dir/${label}.json"
exit "$rc"
