#!/usr/bin/env bash
set -euo pipefail

deploy=/srv/projects/Personal/agent-bus/app/deploy/antler-a6/zulip

test "$(id -u)" -eq 0

install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$deploy/scripts/provision-secrets.sh" /usr/local/libexec/antler-zulip-provision-secrets
install -o root -g root -m 0755 "$deploy/scripts/check-secrets.sh" /usr/local/libexec/antler-zulip-check-secrets
install -o root -g root -m 0755 "$deploy/scripts/start-with-secrets.sh" /usr/local/libexec/antler-zulip-start
/usr/local/libexec/antler-zulip-provision-secrets

echo "Installed AntlerForge Zulip A6-custody launchers; internal credentials are present."
