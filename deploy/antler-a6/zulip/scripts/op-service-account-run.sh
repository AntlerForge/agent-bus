#!/usr/bin/env bash
set -euo pipefail

token_file="${OP_SERVICE_ACCOUNT_TOKEN_FILE:-/etc/1password/service-accounts/zulip-antlerforge.token}"
reference_file="${ZULIP_OP_ENV_FILE:-/etc/zulip-estate/op.env}"

test "$(id -u)" -eq 0
test -x /usr/bin/op
test -f "$token_file"
test -r "$token_file"
test -f "$reference_file"
test -r "$reference_file"

owner="$(stat -c '%U:%G' "$token_file")"
mode="$(stat -c '%a' "$token_file")"
test "$owner" = "root:root"
test "$mode" = "600"

OP_SERVICE_ACCOUNT_TOKEN="$(tr -d '\r\n' < "$token_file")"
test -n "$OP_SERVICE_ACCOUNT_TOKEN"
export OP_SERVICE_ACCOUNT_TOKEN

exec /usr/bin/op run --env-file="$reference_file" -- "$@"
