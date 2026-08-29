# AntlerForge Zulip deployment

This directory deploys only the empty Zulip stack and Gate G0. It contains no
Agent Bus relay, outbound publisher or Agent Bus credential.

## Secret custody

The sole machine authority is `/etc/antlerforge/secrets/zulip-antlerforge`.
The directory is root-owned mode `0700`; its six credential files are
root-owned mode `0600`. Five internal credentials are generated on A6 without
being printed. The SMTP credential is an owner-supplied Gmail app password.
Compose mounts each credential as a named read-only Docker secret. No secret is
passed through an environment file.

## Install

```bash
sudo ./scripts/prepare-data.sh
sudo ./scripts/install-prerequisites.sh
sudo install -m 0644 systemd/antler-zulip-stack.service systemd/antler-zulip.target /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start antler-zulip.target
sudo docker compose ps
curl -fsS http://127.0.0.1:8093/api/v1/server_settings | jq -e '.result == "success"'
```

Startup fails closed until all six files pass the metadata and non-empty checks.
`zulip.antlerforge.com` must route through the existing local-config
`kv-dashboard` tunnel to `http://127.0.0.1:8093`, with Cloudflare Access
protecting the entire hostname.

Create only the disposable Gate G0 organization/admin/channel/topic/message and
test attachment before running `G0-CLIENT-TEST.md`. Estate accounts and data are
phase 2 and must not be added here. The realm name is exactly `AntlerForge`.

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
the declared backed-up data directory. Restart with
`sudo systemctl start antler-zulip.target`.
