#!/usr/bin/env bash
set -euo pipefail

authority=/etc/antlerforge/secrets/zulip-antlerforge
test "$(id -u)" -eq 0
install -d -o root -g root -m 0700 /etc/antlerforge/secrets "$authority"

for name in postgres_password memcached_password rabbitmq_password redis_password secret_key; do
  target="$authority/$name"
  if [[ ! -e "$target" ]]; then
    tmp="$(mktemp "$authority/.${name}.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    umask 077
    openssl rand -base64 48 >"$tmp"
    install -o root -g root -m 0600 "$tmp" "$target"
    rm -f "$tmp"
    trap - EXIT
  fi
  chown root:root "$target"
  chmod 0600 "$target"
done
