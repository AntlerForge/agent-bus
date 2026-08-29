#!/usr/bin/env bash
set -euo pipefail

authority=/etc/antlerforge/secrets/zulip-antlerforge
test "$(id -u)" -eq 0
test "$(stat -c '%U:%G' "$authority")" = root:root
test "$(stat -c '%a' "$authority")" = 700

for name in postgres_password memcached_password rabbitmq_password redis_password secret_key smtp_password; do
  target="$authority/$name"
  test -s "$target"
  test "$(stat -c '%U:%G' "$target")" = root:root
  test "$(stat -c '%a' "$target")" = 600
done
