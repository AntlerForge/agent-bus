#!/usr/bin/env bash
set -euo pipefail

deploy=/srv/projects/Personal/agent-bus/app/deploy/antler-a6/zulip

test "$(id -u)" -eq 0
test -x /usr/bin/op

install -d -o root -g root -m 0700 /etc/1password/service-accounts
install -d -o root -g root -m 0700 /etc/zulip-estate
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0600 "$deploy/zulip.op.env" /etc/zulip-estate/op.env
install -o root -g root -m 0755 "$deploy/scripts/op-service-account-run.sh" /usr/local/libexec/antler-zulip-op-run

if [[ -e /etc/1password/service-accounts/zulip-antlerforge.token ]]; then
  chown root:root /etc/1password/service-accounts/zulip-antlerforge.token
  chmod 0600 /etc/1password/service-accounts/zulip-antlerforge.token
fi

echo "Installed AntlerForge Zulip 1Password references and root-only launcher."
