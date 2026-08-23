#!/usr/bin/env bash
set -euo pipefail

deploy=/srv/projects/Personal/agent-bus/app/deploy/antler-a6/zulip
data=/srv/projects/Personal/zulip-estate/data

cd "$deploy"
systemctl stop antler-zulip.target
docker compose down

test -d "$data"
if ss -ltn | grep -Eq '127\.0\.0\.1:(8093|8094|18093)'; then
  echo "A Zulip trial port remains bound after rollback" >&2
  exit 1
fi
printf 'Stack stopped; declared data preserved at %s\n' "$data"
