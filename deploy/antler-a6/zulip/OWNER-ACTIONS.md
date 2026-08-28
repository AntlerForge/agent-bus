# AntlerForge Zulip — one-time owner actions

Complete this card once. Do not put any secret into chat.

## 1. Create the deployment vault and item

1. Open 1Password and create a vault named exactly `AntlerForge Deployments`.
2. In that vault, create a Secure Note named exactly `zulip-antlerforge`.
3. Add these custom fields. Make the first five fields Password fields and use
   1Password's generated random value (at least 32 characters; use 64 for
   `secret_key`). Enter the SMTP values exactly as shown:

| Field | Type | Value |
|---|---|---|
| `postgres_password` | Password | generated, 32+ characters |
| `memcached_password` | Password | generated, 32+ characters |
| `rabbitmq_password` | Password | generated, 32+ characters |
| `redis_password` | Password | generated, 32+ characters |
| `secret_key` | Password | generated, 64 characters |
| `smtp_password` | Password | the Google app password from step 2 |
| `smtp_host` | Text | `smtp.gmail.com` |
| `smtp_user` | Text | `tonyjbarfoot@googlemail.com` |
| `smtp_port` | Text | `587` |

## 2. Create the Gmail app password

1. Sign in to the Google Account for `tonyjbarfoot@googlemail.com`.
2. Open **Manage your Google Account → Security & sign-in**.
3. Confirm **2-Step Verification** is on. App passwords are unavailable without it.
4. Open <https://myaccount.google.com/apppasswords> and sign in again if asked.
5. Enter the app name `AntlerForge Zulip`, then select **Create**.
6. Copy the displayed 16-character password once into the 1Password field
   `smtp_password`. Do not include spaces and do not paste it anywhere else.

If Google does not offer App passwords, stop and tell the Chief of Staff. This
can happen with Advanced Protection, security-key-only 2-Step Verification, or
some managed accounts; do not weaken the Google account to force it.

## 3. Create the read-only service account

1. Sign in at <https://start.1password.com> and open **Developer → Service accounts**.
2. Select **Create a service account**.
3. Name it exactly `A6 Zulip AntlerForge`.
4. **Can create vaults:** Off.
5. Grant access only to `AntlerForge Deployments`.
6. Open that vault's permissions and select **Read items** only. Leave Write,
   Share and every other permission off.
7. Grant no 1Password Environment access.
8. Create the account. Copy the token immediately; 1Password shows it once.
9. Also select **Save in 1Password** and save the token as
   `A6 Zulip AntlerForge service account` in a private administrative vault,
   not in `AntlerForge Deployments`.
10. In an A6 shell, run this exact command, paste the token, press Enter, then
    press Ctrl-D:

```bash
sudo install -d -o root -g root -m 0700 /etc/1password/service-accounts
sudo sh -c 'umask 077; tr -d "\r\n" > /etc/1password/service-accounts/zulip-antlerforge.token'
```

The token must exist only at that root-owned mode-0600 path on A6 and in the
private 1Password backup item. Do not put it in the Zulip item, a shell profile,
an env file, the repository or chat.

## 4. Create the Cloudflare Access application

1. In the main Cloudflare dashboard, open **antlerforge.com → DNS → Records →
   Add record**.
2. Set **Type** `CNAME`, **Name** `zulip`, **Target**
   `f6a94868-94f5-4b4e-a558-a34a2f302d9f.cfargotunnel.com`, **Proxy status**
   `Proxied`, **TTL** `Auto`, then save. Add no second record for this name.
3. Open **Zero Trust → Access controls → Applications → Add an application →
   Self-hosted**.
4. Create the application and policy exactly as written in
   `CLOUDFLARE-ACCESS-SPEC.md`. Do not add any bypass or service-token policy.

When all four sections are complete, tell the Chief of Staff only: `AntlerForge Zulip owner actions complete`.
