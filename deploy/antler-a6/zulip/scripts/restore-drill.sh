#!/usr/bin/env bash
set -euo pipefail

deploy=/srv/projects/Personal/agent-bus/app/deploy/antler-a6/zulip
live=/srv/projects/Personal/zulip-estate/data/zulip
drill=/srv/projects/Personal/zulip-estate/restore-drill
backup="${1:-}"

if [[ -z "$backup" ]]; then
  backup="$(find "$live/backups" -maxdepth 1 -type f -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
fi
test -n "$backup"
test -s "$backup"
test ! -e "$drill"

install -d -m 0750 "$drill/zulip" "$drill/postgresql" "$drill/rabbitmq" "$drill/redis"
cp -a "$live/." "$drill/zulip/"

cleanup() {
  cd "$deploy"
  ZULIP_DATA_ROOT="$drill" ZULIP_HTTP_PORT=18093 \
    docker compose -p zulip-restore-drill down >/dev/null 2>&1 || true
}
trap cleanup EXIT

cd "$deploy"
export ZULIP_DATA_ROOT="$drill"
export ZULIP_HTTP_PORT=18093

op run --env-file=/etc/zulip-estate/op.env -- \
  docker compose -p zulip-restore-drill up -d database memcached rabbitmq redis
op run --env-file=/etc/zulip-estate/op.env -- \
  docker compose -p zulip-restore-drill run --rm zulip \
  /sbin/entrypoint.sh app:restore "/data/backups/$(basename "$backup")"
op run --env-file=/etc/zulip-estate/op.env -- \
  docker compose -p zulip-restore-drill up -d --wait
curl -fsS http://127.0.0.1:18093/api/v1/server_settings | jq -e '.result == "success"'

echo "Restore drill server healthy on 127.0.0.1:18093; verify the synthetic G0 message before teardown."
read -r -p "Press Enter after message verification to tear down the isolated drill. "
