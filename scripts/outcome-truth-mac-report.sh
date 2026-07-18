#!/bin/zsh
set -euo pipefail
app_dir="${OUTCOME_MAC_APP:-/Users/antonybarfoot/Developer/personal/agent-bus}"
local_snapshot="${TMPDIR:-/tmp}/agent-bus-outcome-mac-snapshot.json"
/usr/local/bin/node "$app_dir/scripts/outcome-truth-mac-probe.mjs" > "$local_snapshot"
/usr/bin/scp -q "$local_snapshot" ajbarfoot@antler-a6:/srv/projects/Personal/agent-bus/runtime/outcome-truth/.mac-snapshot.incoming
/usr/bin/ssh -o BatchMode=yes ajbarfoot@antler-a6 'chmod 600 /srv/projects/Personal/agent-bus/runtime/outcome-truth/.mac-snapshot.incoming && mv /srv/projects/Personal/agent-bus/runtime/outcome-truth/.mac-snapshot.incoming /srv/projects/Personal/agent-bus/runtime/outcome-truth/mac-snapshot.json'

