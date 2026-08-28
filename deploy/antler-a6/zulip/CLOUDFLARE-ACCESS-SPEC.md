# AntlerForge Zulip — Cloudflare Access specification

Create exactly one Access application with these values.

## Application

| Field | Value |
|---|---|
| Application type | Self-hosted |
| Application name | `AntlerForge Zulip` |
| Public hostname | `zulip.antlerforge.com` |
| Path | blank (protect the whole hostname) |
| Application session duration | 24 hours |
| App Launcher visibility | Off |
| Block page | Cloudflare default |
| Identity providers | One-time PIN |
| Automatic identity-provider redirect | On, if One-time PIN is the only provider |
| Accept all available identity providers | Off |
| Authenticate with Cloudflare One Client | Off |
| Browser isolation | Off |
| CORS settings | Off/default |
| Cookie settings | Defaults; do not disable HTTP-only, Secure or SameSite protection |
| Service-token authentication | None |
| Bypass policies | None |

## Policy

| Field | Value |
|---|---|
| Policy name | `Tony only` |
| Action | Allow |
| Precedence | 1 |
| Session duration | Same as application (24 hours) |
| Include rule | Emails — `tonyjbarfoot@googlemail.com` |
| Require rules | None |
| Exclude rules | None |
| Purpose justification | Off |
| Temporary authentication | Off |
| Independent MFA | Off |
| Browser isolation | Off |

Do not add an `Everyone`, `Bypass`, service-token or network-only policy. Gate
G0 deliberately tests whether the unmodified stock Mac, iPhone and iPad Zulip
clients can complete this ordinary Access login and retain the application
cookie for API, event-stream, upload and push traffic.

## Tunnel publication

- Tunnel: `kv-dashboard` (`f6a94868-94f5-4b4e-a558-a34a2f302d9f`)
- Public hostname: `zulip.antlerforge.com`
- Origin service: `http://127.0.0.1:8093`
- Origin TLS settings: not applicable (loopback HTTP)
- No path restriction
- No HTTP Host header override
- No public A6 listener; cloudflared remains outbound-only
