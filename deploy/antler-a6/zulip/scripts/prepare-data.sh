#!/usr/bin/env bash
set -euo pipefail

root="${ZULIP_DATA_ROOT:-/srv/projects/Personal/zulip-estate/data}"
install -d -m 0750 "$root" "$root/zulip" "$root/postgresql" "$root/rabbitmq" "$root/redis"
printf 'Prepared declared Zulip data root: %s\n' "$root"
