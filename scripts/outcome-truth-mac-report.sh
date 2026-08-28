#!/bin/zsh
set -euo pipefail
app_dir="${OUTCOME_MAC_APP:-/Users/antonybarfoot/Developer/personal/agent-bus}"
# launchd starts jobs with $HOME as the working directory. The repository-risk
# sweep owns a versioned relative config path, so anchor the whole reporter at
# its declared application checkout before invoking any Node entrypoint.
cd "$app_dir"
local_snapshot="${TMPDIR:-/tmp}/agent-bus-outcome-mac-snapshot.json"
runtimedir="$HOME/Library/Application Support/Agent Bus/wrapper-liveness"
mkdir -p "$runtimedir"
/usr/local/bin/node "$app_dir/scripts/mac-wrapper-liveness.mjs" > "$runtimedir/latest.json"
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

# This legacy semantic completion log lives in iCloud Drive and can be evicted
# between scheduled runs. Materialise the single required file before the Node
# probe reads it; otherwise macOS reports EAGAIN and the whole outcome snapshot
# is lost.
project_store_log="$HOME/Documents/Admin/knowledge-vault/logs/project-store-sync-bridge.log"
if [[ -x /usr/bin/brctl && -e "$project_store_log" ]]; then
  /usr/bin/brctl download "$project_store_log" >/dev/null 2>&1 || true
  for _ in {1..20}; do
    [[ ! "$(stat -f '%Sf' "$project_store_log" 2>/dev/null)" =~ dataless ]] && break
    sleep 0.25
  done
fi

/usr/local/bin/node "$app_dir/scripts/outcome-truth-mac-probe.mjs" > "$local_snapshot"

upload_snapshot() {
  /usr/bin/scp -q \
    -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=1 \
    "$local_snapshot" \
    ajbarfoot@antler-a6:/srv/projects/Personal/agent-bus/runtime/outcome-truth/.mac-snapshot.incoming &&
    /usr/bin/ssh \
      -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=1 \
      ajbarfoot@antler-a6 \
      'chmod 600 /srv/projects/Personal/agent-bus/runtime/outcome-truth/.mac-snapshot.incoming && mv /srv/projects/Personal/agent-bus/runtime/outcome-truth/.mac-snapshot.incoming /srv/projects/Personal/agent-bus/runtime/outcome-truth/mac-snapshot.json'
}

reconcile_return() {
  local availability="${TMPDIR:-/tmp}/agent-bus-mac-availability.json"
  local reconciliation="${TMPDIR:-/tmp}/agent-bus-mac-reconciliation.json"
  /usr/bin/scp -q -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=1 \
    ajbarfoot@antler-a6:/srv/projects/Personal/agent-bus/runtime/outcome-truth/mac-availability.json "$availability" || return 0
  /usr/local/bin/node "$app_dir/scripts/mac-return-reconcile.mjs" "$availability" "$reconciliation"
  [[ -s "$reconciliation" ]] || return 0
  /usr/bin/scp -q -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=1 \
    "$reconciliation" ajbarfoot@antler-a6:/srv/projects/Personal/agent-bus/runtime/outcome-truth/.mac-reconciliation.incoming &&
    /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=1 ajbarfoot@antler-a6 \
      'chmod 600 /srv/projects/Personal/agent-bus/runtime/outcome-truth/.mac-reconciliation.incoming && mv /srv/projects/Personal/agent-bus/runtime/outcome-truth/.mac-reconciliation.incoming /srv/projects/Personal/agent-bus/runtime/outcome-truth/mac-reconciliation.json'
}

# The Mac-to-A6 SSH edge occasionally closes a connection during wake/network
# convergence. Retry within this scheduled run so a brief transport miss does
# not defer semantic truth for another fifteen minutes.
for attempt in 1 2 3; do
  if upload_snapshot; then
    reconcile_return
    exit 0
  fi
  (( attempt < 3 )) && sleep $(( attempt * 2 ))
done

echo "Mac outcome snapshot upload failed after 3 attempts" >&2
exit 1
