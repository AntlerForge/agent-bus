#!/bin/bash
set -u

label="$1"
shift
state_dir="$HOME/Library/Application Support/AntlerForge/outcome-truth"
mkdir -p "$state_dir"
max_attempts="${OUTCOME_MAX_ATTEMPTS:-1}"
retry_delay_seconds="${OUTCOME_RETRY_DELAY_SECONDS:-15}"
attempt=1
while true; do
  "$@"
  rc=$?
  if (( rc == 0 || attempt >= max_attempts )); then
    break
  fi
  sleep $(( retry_delay_seconds * attempt ))
  attempt=$(( attempt + 1 ))
done
tmp="$state_dir/.${label}.$$"
printf '{"label":"%s","completed_at":"%s","exit_code":%d}\n' \
  "$label" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rc" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$state_dir/${label}.json"
exit "$rc"
