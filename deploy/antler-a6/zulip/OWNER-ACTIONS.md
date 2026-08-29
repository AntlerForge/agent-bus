# AntlerForge Zulip — one-time owner actions

Complete this card once. Do not put any secret into chat.

## 1. Create and install the Gmail app password

1. Sign in to the Google Account for `tonyjbarfoot@googlemail.com`.
2. Open **Manage your Google Account → Security & sign-in** and confirm
   **2-Step Verification** is on.
3. Open <https://myaccount.google.com/apppasswords>, enter the app name
   `AntlerForge Zulip`, and select **Create**.
4. In an A6 shell, run the command below. Paste the displayed app password,
   press Enter, then press Ctrl-D. The command emits no value.

```bash
sudo sh -c 'umask 077; tr -d "\r\n " > /etc/antlerforge/secrets/zulip-antlerforge/smtp_password' && sudo chown root:root /etc/antlerforge/secrets/zulip-antlerforge/smtp_password && sudo chmod 0600 /etc/antlerforge/secrets/zulip-antlerforge/smtp_password
```

If Google does not offer App passwords, stop and tell the Chief of Staff. Do
not weaken the Google account to force it.

## 2. Complete the two Cloudflare actions

1. In **antlerforge.com → DNS → Records**, add one proxied `CNAME`: name
   `zulip`, target
   `f6a94868-94f5-4b4e-a558-a34a2f302d9f.cfargotunnel.com`, TTL `Auto`.
2. In **Zero Trust → Access controls → Applications**, create the self-hosted
   application and policy exactly as specified in `CLOUDFLARE-ACCESS-SPEC.md`.
   Add no bypass or service-token policy.

## 3. Preserve the British Gas password

Save the British Gas password from the named owner handoff into Tony's human
password manager. Tell the Chief of Staff when this is complete so the
transient handoff can be removed.

Then tell the Chief of Staff only: `AntlerForge Zulip owner actions complete`.
