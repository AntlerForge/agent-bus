# Zulip agent rooms trial architecture

Status: accepted design; implementation requires a separate governed work item
Authority: Tony's approval on 2026-08-23, requirements R1-R9 as amended
Work item: `work_20260823_152101_b318`
Decision: `decisions/0020-run-zulip-as-a-governed-conversation-layer-trial.yaml`
Author: Estate Architect

## Outcome

Run a two-week self-hosted Zulip trial as the estate's conversation route. Tony
uses the stock Mac, iPhone and iPad apps. Addressed room messages reach the named
role through Agent Bus. Replies return under that role's Zulip account. Agent Bus
continues to own transport and the Work Ledger continues to own work state.

The design does not authorize implementation. Cursor independently approved it
on 2026-08-23 after one changes-requested cycle, and Tony had already approved
the trial. The Estate Operations Manager must accept all nine operability lines
before the service is live.

## 1. Requirements held verbatim

The build contract is `/tmp/zulip-agent-rooms-requirements.md` on A6. R1-R9 and
the Coherence Manager's A1-A6 amendments remain binding. This design adds two
details that the requirements did not yet contain:

1. `estate-architect` is now a persistent role and receives its own bot account.
2. A dedicated `estate-relay` bot listens for inbound events. It is not a role
   and cannot speak for one.

Neither addition changes Tony's stated outcome. With Tony, four persistent
roles, codex and the relay bot, the deployment has seven non-deactivated users.

## 2. Architecture gate

[CHANGE CLASS: platform-remote]

Reason: the change adds an external conversation system, two adapter processes,
new credentials, public edge routing, durable state, alert mirroring and new
runtime flows.

ADR/update required: yes. ADR 0020 is the proposed decision. Active changes to
`architecture.yaml` and the home-platform records wait for acceptance.

Decision: design records may proceed. Product code, Compose files, live routes
and credentials remain blocked pending review and acceptance.

### Invariant check

| Invariant | Design response |
| --- | --- |
| P-001 transport/work separation | Zulip messages enter Bus as conversation. Only Work Ledger operations change work state. |
| P-002 source authority | Every relayed message and derived work event carries the Zulip message id and permalink. |
| P-003 proposals need authority | Room traffic is `consult`; no automatic approval or assignment exists. |
| P-004 receipt before done | Unchanged. Room delivery cannot complete a work item. |
| P-005 inspectable runtime | Spool and correlation records are atomic JSON. Events remain readable without a dashboard. |
| P-006 selector is advisory | Wake routes are declared delivery targets, not selector-driven authority. |
| P-007 AMB isolation | No Zulip component reads or writes AMB state. AMB retirement is out of scope. |
| I-001 localhost binding | Zulip and adapter health endpoints bind only to `127.0.0.1`. Cloudflare Tunnel is outbound-only. |
| I-002 secrets | 1Password supplies Compose secrets and bot keys at process start. No `.env`, repo or prompt stores a value. |
| I-003 health/version | The estate adapter exposes combined `/healthz` and `/version`; Docker health covers the third-party stack. |
| I-004 KV writer | No Zulip component mounts or writes the Knowledge Vault. |
| I-005 logging | Bind structured logs to `~/var/log/home-platform/zulip/`, daily rotation, 30 days. |
| I-006 port registry | Reserve loopback ports 8093 and 8094 in `reverse-proxy-routing.yaml` before deployment. |
| I-007 intelligence at edge | Relay, routing, correlation and health are deterministic. Provider intelligence remains behind Agent Bus bridges. |

No invariant waiver is proposed.

### Anti-pattern check

- AP-01 is avoided by keeping conversation transport out of the Work Ledger.
- AP-03 is avoided by loopback-only listeners.
- AP-04 is avoided by 1Password startup injection.
- AP-06 is handled by the architecture delta in section 13.
- AP-08 is handled by reserving both ports before deployment.

## 3. Component design

```text
Stock Zulip clients
        |
        v
Cloudflare Tunnel and tested Access edge
        |
        v
Zulip stack on A6, 127.0.0.1:8093
        |
        +---- event API ----> inbound relay ----> role Bus inbox
        |                         |                    |
        |                         +---- consult wake -> declared provider bridge
        |                                              |
        |                                              v
        |                                         role response
        |                                              |
        +<---- role API key ---- outbound publisher <--+

Home Assistant alert spine ---- existing alert record ---- mirror publisher
```

### 3.1 Zulip stack

Use the pinned official `ghcr.io/zulip/zulip-server` image and its supported
Docker Compose topology: Zulip, PostgreSQL, RabbitMQ, Redis and Memcached. At
design time the current official image is `12.1-0`; the builder must pin the
then-current stable patch and record its digest rather than use `latest`.

Canonical deployment files live in the Agent Bus repository under
`deploy/antler-a6/zulip/`. The deployed checkout is on A6. Persistent state is
bind-mounted below `/srv/projects/Personal/zulip-estate/data/`; it is never a
Docker volume hidden outside the declared Borg source tree.

The stack exposes HTTP only to `127.0.0.1:8093`. Cloudflare terminates TLS. The
Zulip reverse-proxy configuration trusts only the local tunnel hop and the
forwarded HTTPS scheme. No router port, wildcard bind or federation is allowed.

### 3.2 Inbound relay

Planned module: `src/zulip/inbound-relay.mjs`
Planned service: `antler-zulip-inbound.service`

Responsibilities:

- authenticate as `estate-relay` and subscribe only to declared channels;
- use Zulip's supported long-poll event queue with exponential retry;
- accept direct mentions, replies to a role bot, and messages in a channel that
  the role route explicitly owns;
- reject unaddressed traffic without waking a provider;
- write an atomic spool record before attempting Bus delivery;
- deliver one idempotent `consult` message to the role inbox;
- send one correlated `consult` wake to the first fresh declared execution
  target, without claiming that target occupies the role;
- heartbeat to Agent Bus using the normal authenticated heartbeat path;
- expose no Zulip send operation.

The Zulip API key can technically post because Zulip bot keys are not scoped
read-only. The process boundary is therefore important: this service contains no
send-message code, no role keys and no outbound publisher import.

### 3.3 Outbound publisher

Planned module: `src/zulip/outbound-publisher.mjs`
Planned service: `antler-zulip-outbound.service`

Responsibilities:

- read only Bus threads listed in correlation records;
- accept only a response on a relay-created wake thread;
- derive the acting role from the signed correlation, never from reply prose;
- select a role key from a fixed allowlist;
- post once to the original Zulip channel and topic;
- store the posted Zulip message id and advance the correlation atomically;
- write a local heartbeat file consumed by the inbound service's combined
  health report.

It has no Agent Bus write token. It holds the allowlisted role keys, which is a
known blast-radius concentration. For the two-week trial this is accepted over
six almost-identical publisher processes. If the trial settles to adopt, split
per-role credentials only if review or evidence shows the shared publisher is a
material risk.

### 3.4 Alert mirror

The mirror consumes already-authorized alert transition records. Producers do
not call Zulip. During the trial it copies a representative automation failure,
the daily digest ready notice and one action-needed item into the appropriate
channel, under the owning named role, mentioning Tony.

Home Assistant delivery happens first or independently. Zulip mirror failure
cannot suppress it. No new interrupt class is introduced.

### 3.5 Combined health adapter

The inbound service exposes `127.0.0.1:8094/healthz` and `/version`.
`/healthz` is semantic. Expected green shape:

```json
{
  "status": "ok",
  "zulip_http": "ok",
  "event_queue": "connected",
  "bus_heartbeat": "authenticated",
  "publisher": "ok",
  "spool_depth": 0,
  "last_check": "RFC3339 timestamp"
}
```

An idle event queue still updates its heartbeat. A publisher with no work stamps
`idle-ok`; silence is never interpreted as success. `bridge:doctor` checks this
endpoint and the `zulip-relay` authenticated heartbeat.

### 3.6 Agent Bus writer inventory boundary

Only the inbound relay is a new Agent Bus writer. Before deployment it receives
one row in `docs/write-token-cutover-inventory.md`, the existing Bus write token
is distributed to its service through 1Password, the consumer is restarted, and
an authenticated heartbeat plus a bridge-doctor round trip must pass. The
cutover order is distribute, restart consumer, verify, then enforce. It is never
enforcement first.

The outbound publisher is not an Agent Bus writer. It receives no Bus write
token and cannot mutate Bus or Work Ledger state. It is a Zulip API writer, so
its role-key allowlist, rotation and semantic heartbeat belong in the service
catalog and credential register, not the Agent Bus authenticated-writer
inventory. The Zulip stack is likewise not a Bus writer.

## 4. Interfaces and durable data

### 4.1 Role route configuration

Canonical tracked file: `config/zulip-role-routes.json`.

```json
{
  "schema_version": 1,
  "routes": [
    {
      "role_id": "chief-of-staff",
      "zulip_user_id": 0,
      "primary_wake_target": "claude-code",
      "fallback_wake_target": "codex",
      "owned_channels": ["front-door"],
      "enabled": true
    }
  ]
}
```

The deployed file must match the tracked digest and join the replica-parity
registry. `last_seen` is intentionally absent. A wake target is a delivery
choice, not occupancy evidence.

### 4.2 Correlation record

Runtime path:
`/srv/projects/Personal/agent-bus/runtime/zulip-relay/correlations/<realm>-<message>-<role>.json`

```json
{
  "schema_version": 1,
  "realm_id": 0,
  "zulip_message_id": 0,
  "zulip_sender_id": 0,
  "zulip_permalink": "https://chat.example/#narrow/...",
  "channel": "front-door",
  "topic": "task topic",
  "target_role": "chief-of-staff",
  "bus_message_id": "msg_...",
  "bus_thread_id": "thread_...",
  "wake_target": "claude-code",
  "wake_message_id": "msg_...",
  "delivery_status": "delivered",
  "last_bus_seq_published": 0,
  "posted_zulip_message_id": null,
  "created_at": "RFC3339 timestamp",
  "updated_at": "RFC3339 timestamp"
}
```

Allowed `delivery_status` values are `spooled`, `delivered`, `wake-pending`,
`wake-delivered`, `replied`, `failed`. Every transition is atomic. The
idempotency key is `zulip:<realm_id>:<message_id>:<target_role>`.

### 4.3 Authority flow

1. Tony writes a room message.
2. Relay records it and sends a `consult` message with `source_ref` set to the
   Zulip permalink and immutable message id.
3. The role reads and responds. No work state has changed.
4. If Tony's words contain a bounded instruction, the Chief of Staff may invoke
   the existing scoped owner-decision relay. The ledger event records the quote,
   `where_said` permalink and relaying role.
5. Other roles propose work or route the raise to the Chief of Staff. They do
   not manufacture Tony's approval.

For a room message about an existing KV or backlog record, that record remains
the canonical `source_ref`; the Zulip message is recorded in `context_ref` or
`where_said`. A raise originating in Zulip may use its immutable message id and
permalink as `source_ref`. The conversation citation provides A3 provenance and
does not silently replace P-002 source authority.

## 5. Accounts, channels and registers

Accounts:

- `tony`, human owner;
- `chief-of-staff`, `coherence-manager`, `estate-operations-manager`,
  `estate-architect`, named role bots;
- `codex`, named work-agent bot;
- `estate-relay`, listener bot that never speaks for a role.

Launch channels:

- `estate-ops`: agent-only technical register;
- `front-door`: Tony and Chief of Staff, plain-English register;
- one named project channel selected by Tony before launch.

Topics name one task or activity. Each channel description states its register.
Any channel containing Tony uses plain English and never presents a decision as
a bare work-item id.

## 6. Cloud sandbox ruling

`antlerforge.zulipchat.com` contains no estate messages, files, role accounts,
bot keys, health, family or financial information. It may be used to learn the
client and test:

- switching between organizations;
- channel and topic naming;
- notification settings;
- channel descriptions and register wording.

The stock apps support multiple organizations, so the sandbox and self-hosted
trial can coexist in the client. There is no cross-organization sync. If the
self-hosted trial passes, naming conventions may be recreated manually. If it
fails, the sandbox still does not become the estate conversation store.

## 7. Cloudflare edge compatibility gate

Cloudflare Access checks every protected request for a `CF_Authorization`
cookie. Service tokens require custom headers. Zulip's stock mobile client does
not document custom Access headers. Compatibility is therefore unproved and is
likely to fail once the native client leaves the browser login flow.

Gate G0 runs before accounts or estate data are added:

1. Start the empty local organization behind a temporary Access-protected
   Tunnel hostname.
2. Add it in the Mac, iPhone and iPad stock clients.
3. On each client, prove login, channel list, send, receive, topic navigation,
   file access and a 20-minute real-time event session.
4. Register push and prove a mention arrives within one minute on iPhone and
   iPad.
5. Repeat after the Access session has been refreshed once.

Pass: retain Access and record its policy name and session duration.
Fail: stop. Do not add bypass rules piecemeal. Put these choices to Tony:

- recommended: dedicated Cloudflare Tunnel hostname with Zulip authentication,
  closed invitations, no anonymous access, federation disabled and Cloudflare
  network controls;
- private: Tailscale-only HTTPS, requiring Tailscale on every client device.

The builder may not silently choose either fallback.

## 8. Credentials and rotation

| Credential | Consumer | 1Password item | Rotation and pickup |
| --- | --- | --- | --- |
| Zulip application and internal database/cache secrets | Compose stack | one scoped Zulip deployment item | Generate before first start. For rotation, follow the official component procedure, then `systemctl restart antler-zulip-stack.service`. |
| SMTP credential | Zulip stack | existing approved mail item or new Tony-approved item | Replace in 1Password and restart stack. Deployment blocks if no approved SMTP route exists. |
| `estate-relay` API key | inbound service | Zulip relay item | Regenerate in Zulip, update 1Password, restart inbound service, verify `/users/me` and heartbeat. |
| role and codex API keys | outbound service | one item per account | Regenerate one account, update 1Password, restart outbound service, run read-only `/users/me` checks for all allowlisted accounts. |
| Agent Bus write token | inbound service only | existing Agent Bus token item | Inventory first, distribute, restart inbound service, then verify authenticated heartbeat. Never enforce first. |
| Cloudflare tunnel/Access material | cloudflared | existing Cloudflare item and config authority | Rotate under the existing cloudflared runbook. Verify stock clients after rotation. |

The Compose launcher runs under `op run`. No secret value appears in Git,
Compose YAML, an environment file, a catalog row, a log or this design.

## 9. Data placement, backup and restore

Canonical state:

```text
/srv/projects/Personal/zulip-estate/data/
  zulip/          # /data, including application backups and uploads
  postgresql/     # PostgreSQL data
  rabbitmq/       # RabbitMQ state
  redis/          # Redis state
```

Memcached is disposable. The official Docker backup unit is the Zulip `/data`
volume containing a recent `app:backup` database dump. Enable the image's
automatic backup and run an explicit backup before every restore drill:

```bash
cd /srv/projects/Personal/agent-bus/app/deploy/antler-a6/zulip
sudo docker compose exec -T zulip /sbin/entrypoint.sh app:backup
sudo systemctl start antler-a6-borg-backup.service
```

Proof that the latest Borg archive contains the backup:

```bash
archive=$(sudo borg list --short --last 1 /mnt/backup/borg/a6-primary)
sudo borg list "/mnt/backup/borg/a6-primary::$archive" \
  | rg 'srv/projects/Personal/zulip-estate/data/zulip/backups/'
```

Expected green: at least one non-empty backup file path. The build receipt must
include the archive name and path, never backup contents.

Before acceptance, restore the newest backup into the isolated Compose project
`zulip-restore-drill` on loopback port 18093. Do not restore over the live
database. Prove `GET /api/v1/server_settings`, sign in with a disposable drill
admin, verify one synthetic channel/topic/message, then tear the drill down.
Record commands and evidence in the implementation receipt. A backup without
that restore proof fails acceptance.

## 10. Runbook contract

Planned units:

- `antler-zulip.target`
- `antler-zulip-stack.service`
- `antler-zulip-inbound.service`
- `antler-zulip-outbound.service`

Exact operator commands:

```bash
sudo systemctl start antler-zulip.target
sudo systemctl stop antler-zulip.target
sudo systemctl restart antler-zulip-stack.service
sudo systemctl restart antler-zulip-inbound.service antler-zulip-outbound.service
systemctl status antler-zulip-stack.service antler-zulip-inbound.service antler-zulip-outbound.service
cd /srv/projects/Personal/agent-bus/app/deploy/antler-a6/zulip && sudo docker compose ps
curl -fsS http://127.0.0.1:8093/api/v1/server_settings | jq -e '.result == "success"'
curl -fsS http://127.0.0.1:8094/healthz | jq -e '.status == "ok" and .spool_depth == 0'
```

Expected green: every unit active, all Compose containers healthy, server
settings returns `success`, combined health returns `ok`, event queue connected,
authenticated Bus heartbeat current, publisher `ok` or `idle-ok`, spool zero.

Standing EOM recovery authority covers read-only diagnosis, restarting these
units, replaying the idempotent spool, and verifying health. Tony confirmation
is required for credential rotation, restore over live state, deleting messages
or accounts, disabling the edge, changing alert classes, or settling the trial.

## 11. Failure modes

| Symptom | Diagnosis | Bounded recovery | Monitoring and Tony view |
| --- | --- | --- | --- |
| A6 unreachable | External A6 observer fails | Existing A6 recovery runbook; Zulip cannot self-report | HA remains the alert path |
| Tunnel or Access unavailable | Local 8093 healthy, external client fails | Restart cloudflared under existing authority; verify policy and client | HA reports room-path failure |
| Zulip stack unhealthy | Compose health or server settings fails | Inspect logs, restart stack, verify DB and queues | Combined health fails; HA alert |
| Inbound relay down | Relay heartbeat stale; room messages remain in Zulip | Restart inbound; replay spool idempotently | HA alert; Tony sees delayed responses |
| Agent Bus unavailable | Spool grows, Bus health fails | Keep spooled; restart/recover Bus; replay | HA alert; no raise is discarded |
| Wake target unavailable | Role inbox delivered, wake delivery failed | Try the declared fresh fallback once; otherwise leave `wake-pending` | Digest and health show pending wake; no false completion |
| Outbound publisher down | Bus reply exists, Zulip reply absent | Restart publisher; republish by correlation id | HA alert; Tony sees missing room reply |
| Role key invalid | `/users/me` fails for one allowlisted account | Regenerate with Tony authority, update 1Password, restart publisher | Health names account, never key |
| Push unavailable | Messages visible in app, mention push absent | Check push registration and outbound HTTPS; keep HA dual-carry | R2/R7 fail; no alert cutover |
| Backup stale or absent | No recent `/data/backups` file or Borg path | Run app backup, Borg, then isolated restore drill | Service cannot pass EOM gate |
| Start before dependency | Relay sees Zulip or Bus unavailable | Start degraded, stamp failure, back off, spool; never silently exit | Health is degraded with named dependency |
| Duplicate event | Existing idempotency record | Return existing Bus/correlation ids, no second wake | Counted as deduplicated, not error |

Logs live under `~/var/log/home-platform/zulip/` and rotate daily for 30 days.
Credential values and message bodies marked sensitive are excluded from health
and ordinary logs.

## 12. Cost, ownership and reversibility

Owner: Estate Operations Manager after acceptance.
Design authority: Estate Architect.
Mission outcome and settle evidence: Coherence Manager.
Intake trace and Tony-facing digest: Chief of Staff.

Expected direct software cost is GBP 0 per month while the organization remains
under ten non-deactivated users. Zulip's self-hosted push Free plan covers that
size. The existing Cloudflare plan and domain are reused. Incremental electricity
and backup-storage cost are unknown and must be measured during the trial. The
relay performs no model inference. Provider turns continue to report known usage
through the Work Ledger.

Catalog the stack, inbound relay and outbound publisher before they become live.
Record their mode, owner, run-ledger behavior or exemption, health command and
output surface. `automation_catalog.py validate` must pass.

Revert path:

1. stop `antler-zulip.target`;
2. disable its units and remove the Cloudflare hostname after Tony confirms;
3. preserve the final `/data` application backup and trial evidence;
4. deactivate role and relay accounts;
5. remove Zulip checks from bridge doctor, the writer inventory, platform port
   registry, parity registry, catalog and alert mirror;
6. archive deployment config and correlation records, never silently delete;
7. keep AMB, Buzz, noticeboard and HA unchanged unless separately settled.

Named tendrils are: Cloudflare hostname and Access application, DNS, Compose
project, four systemd units/target, 1Password items, role route config, Agent
Directory identities, writer inventory row, bridge-doctor check, platform ports,
backup/restore runbook, automation catalog rows, HA alert mirror, architecture
records, correlation/spool state and the CoS digest route.

## 13. Architecture changes on acceptance

Update Agent Bus `architecture.yaml` with:

- ExternalSystem `zulip-server`;
- Components `zulip-inbound-relay` and `zulip-outbound-publisher`;
- DataStore `zulip-relay-runtime`;
- Flow `zulip-message-to-role-consult`;
- Flow `agent-reply-to-zulip-topic`;
- Flow `ha-alert-dual-carry-to-zulip`;
- FitnessCheck `zulip-conversation-health`;
- ADR 0020 in the generated decision view.

Update the home-platform architecture with a Zulip service, ports 8093 and
8094, Cloudflare route, deployment location, Borg/Restic coverage and the
combined health check. Regenerate `AGENTS.md` and `ARCHITECTURE.md` only after
the ADR becomes active.

Planned Agent Bus implementation files:

```text
src/zulip/inbound-relay.mjs
src/zulip/outbound-publisher.mjs
src/zulip/correlation-store.mjs
src/zulip/role-routes.mjs
scripts/zulip-doctor.mjs
config/zulip-role-routes.json
deploy/antler-a6/zulip/compose.yaml
deploy/antler-a6/zulip/compose.override.yaml
deploy/antler-a6/zulip/systemd/*
test/zulip-*.test.mjs
```

## 14. Acceptance trace

| Requirement | Evidence required |
| --- | --- |
| R1 | A6 Compose health, loopback binds, edge proof on all three clients, data paths and Borg restore |
| R2 | Mention push on iPhone and iPad within one minute, push registration recorded |
| R3 | Seven named active accounts, keys in 1Password, unused accounts deactivated |
| R4 | Three launch channels, descriptions state register, task/activity topics used |
| R5 | Mention and owned-channel relay, idempotent spool, authenticated heartbeat, no Zulip send path in inbound process |
| R6 | Replies appear once under the mapped role or codex account |
| R7 | Three mirrored alerts, tap into conversation, reply reaches owner, any work change cites Zulip source in ledger |
| R8 | iPhone front-door raise becomes governed work, one agent-only consult, no loss, no bare identifiers |
| R9 | No retirements at deploy, two-week window, cost evidence, settle decision within one week |
| A1 | d282 independent review passed; inbound relay inventoried before deployment; bridge doctor check live |
| A2 | Receipt states room wake is not seat occupancy and does not close bus-native wake gap |
| A3 | Room-originated ledger event includes immutable message id and permalink |
| A4 | Tony-facing room decisions rendered in plain English with id as reference |
| A5 | Adopt/revert/blend decision dated and signed by Tony |
| A6 | `/data` backup path appears in Borg and isolated restore succeeds |

Independent review must test the authority flow, Cloudflare gate, role wake
non-occupancy claim, credential split, backup unit and the numbered EOM mapping
below.

## 15. Estate Operations Manager operability acceptance

The Estate Architect cannot waive these checks. Each line must be executable by
the Estate Operations Manager before service acceptance; only Tony may record a
waiver.

| # | Required operability line | Design answer and acceptance evidence |
| --- | --- | --- |
| 1 | Runbook with commands | Section 10 names every unit and gives exact start, stop, restart, status and semantic-health commands. Section 11 maps symptom to diagnosis and bounded recovery. Section 10 draws standing EOM authority versus Tony-gated action and names Zulip, Agent Bus, cloudflared, Home Assistant and Borg as dependencies. |
| 2 | Semantic, operator-executable health | Section 3.5 defines the read-only `/healthz` result for event delivery, authenticated Bus heartbeat, publisher state and spool depth. Idle produces `idle-ok` plus `last_check`; silence never passes. Section 10 gives the exact `curl` and expected-green result. |
| 3 | Failure modes, including silent and start-order failure | Section 11 declares twelve modes, what monitoring and Tony see, bounded recovery, and degraded start behavior when Zulip or Agent Bus is absent. A missing heartbeat, an unstamped idle path or silent process is unhealthy. |
| 4 | Credential lifecycle and ordered enforcement | Section 8 lists each credential, 1Password authority, rotation, restart and verification. Section 3.6 says only inbound is a Bus writer and fixes the order as distribute, restart, verify, enforce. No secret enters Git, prompts, catalog rows or logs. |
| 5 | Backup proved by restore | Section 9 names durable paths, the Zulip application-backup command, the Borg archive proof and an isolated restore on port 18093. Acceptance requires one synthetic channel, topic and message after restore; backup without restore fails. |
| 6 | Cost stated or unknown | Section 12 states GBP 0 direct software cost under ten active users, declares electricity and backup storage unknown pending measurement, identifies no model inference in the relay, and requires provider-reported usage through the Work Ledger where available. |
| 7 | Owned, catalogued and inside alert policy | Section 12 assigns the operating owner, requires catalog rows and validation, and records run-ledger behavior or exemption. Section 3.4 keeps Home Assistant first or independent and introduces no new interrupt class. |
| 8 | Reversible with tendrils listed | Section 12 gives the seven-step retire path and enumerates DNS, Access, Compose, units, secrets, routes, identities, inventory, doctor, ports, backup, catalog, alerts, architecture, spool and digest tendrils. |
| 9 | One config authority with parity checking | Section 4.1 makes `config/zulip-role-routes.json` canonical and requires digest parity. Sections 9 and 13 name A6 data and deployment authorities. Acceptance adds deployment config and route digests to the replica-parity registry; divergent copies fail health. |

## 16. Primary references

- Zulip Docker image and requirements: <https://github.com/zulip/docker-zulip>
- Zulip reverse-proxy requirements: <https://zulip.readthedocs.io/en/stable/production/reverse-proxies.html>
- Zulip Docker backup guidance: <https://github.com/zulip/zulip/blob/main/docs/production/export-and-import.md>
- Zulip mobile push service: <https://zulip.readthedocs.io/en/latest/production/mobile-push-notifications.html>
- Zulip real-time events API: <https://dev.zulip.com/api/real-time-events>
- Zulip multiple organizations: <https://zulip.com/help/switching-between-organizations>
- Cloudflare Access authorization cookie: <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/>
- Cloudflare Access service tokens: <https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/>

Signed: Estate Architect
