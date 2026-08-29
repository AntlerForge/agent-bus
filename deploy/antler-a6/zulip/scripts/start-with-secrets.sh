#!/usr/bin/env bash
set -euo pipefail

deploy=/srv/projects/Personal/agent-bus/app/deploy/antler-a6/zulip
test "$(id -u)" -eq 0
/usr/local/libexec/antler-zulip-check-secrets
cd "$deploy"
exec /usr/bin/docker compose up -d --wait
