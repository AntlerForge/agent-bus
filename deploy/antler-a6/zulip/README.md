# Zulip phase-1 trial deployment

This directory deploys only the empty Zulip stack and Gate G0. It contains no
Agent Bus relay, outbound publisher or Agent Bus credential.

## Prerequisites

- `/usr/local/bin/op` authenticated for unattended `op run`.
- A 1Password item containing the fields in `zulip.op.env.example` and a
  sanctioned SMTP route.
- `/etc/zulip-estate/op.env`, mode `0600`, containing only `op://` references.
- `zulip.antlerforge.com` routed through the existing local-config
  `kv-dashboard` tunnel to `http://127.0.0.1:8093`.
- A Cloudflare Access application protecting the whole hostname.

## Install

```bash
sudo ./scripts/prepare-data.sh
sudo install -m 0644 systemd/antler-zulip-stack.service systemd/antler-zulip.target /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start antler-zulip.target
sudo docker compose ps
curl -fsS http://127.0.0.1:8093/api/v1/server_settings | jq -e '.result == "success"'
```

Create only the disposable Gate G0 organization/admin/channel/topic/message and
test attachment before running `G0-CLIENT-TEST.md`. Estate accounts and data are
phase 2 and must not be added here.

## Backup and isolated restore

```bash
sudo docker compose exec -T zulip /sbin/entrypoint.sh app:backup
sudo systemctl start antler-a6-borg-backup.service
archive=$(sudo borg list --short --last 1 /mnt/backup/borg/a6-primary)
sudo borg list "/mnt/backup/borg/a6-primary::$archive" | rg 'srv/projects/Personal/zulip-estate/data/zulip/backups/'
sudo ./scripts/restore-drill.sh
```

The restore drill uses project `zulip-restore-drill`, data root
`/srv/projects/Personal/zulip-estate/restore-drill`, and loopback port 18093.
It never restores over live state.

## Rollback demonstration

`sudo ./scripts/rollback.sh` stops and removes containers/networks while keeping
only the declared backed-up data directory. Restart with
`sudo systemctl start antler-zulip.target`.
