#!/bin/zsh
set -euo pipefail
app_dir="${OUTCOME_MAC_APP:-/Users/antonybarfoot/Developer/personal/agent-bus}"
local_snapshot="${TMPDIR:-/tmp}/agent-bus-outcome-mac-snapshot.json"
risk_cache="${REPO_RISK_OUTPUT:-$HOME/Library/Application Support/Agent Bus/repo-risk/latest.json}"
refresh_risk=0
if [[ ! -f "$risk_cache" ]]; then
  refresh_risk=1
else
  cache_age_seconds=$(( $(date +%s) - $(stat -f %m "$risk_cache") ))
  (( cache_age_seconds >= 604800 )) && refresh_risk=1
fi
if (( refresh_risk )); then
  REPO_RISK_OUTPUT="$risk_cache" /usr/local/bin/node "$app_dir/scripts/repo-risk-sweep.mjs" >/dev/null
fi
/usr/local/bin/node "$app_dir/scripts/outcome-truth-mac-probe.mjs" > "$local_snapshot"
/usr/bin/scp -q "$local_snapshot" ajbarfoot@antler-a6:/srv/projects/Personal/agent-bus/runtime/outcome-truth/.mac-snapshot.incoming
/usr/bin/ssh -o BatchMode=yes ajbarfoot@antler-a6 'chmod 600 /srv/projects/Personal/agent-bus/runtime/outcome-truth/.mac-snapshot.incoming && mv /srv/projects/Personal/agent-bus/runtime/outcome-truth/.mac-snapshot.incoming /srv/projects/Personal/agent-bus/runtime/outcome-truth/mac-snapshot.json'
