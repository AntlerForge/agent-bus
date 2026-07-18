# Agent Work Ledger

## Boundary

Agent Bus and Agent Work Ledger are adjacent parts of one control surface:

- Agent Bus owns messages, delivery, acknowledgements, threads and shared artifacts.
- Agent Work Ledger owns work items, human ownership, agent delegation, runs, events,
  receipts, reviews and usage.
- A thread can be linked to a run through `thread_id`, but thread status never changes
  task status automatically.
- KV tasks, software backlog items and GitHub issues remain their own source authority.
  A ledger item links back through `source_ref`.

## User workflow

1. Select **New task** in the dashboard or ask an agent to call
   `propose_work_item`.
2. The work item enters `proposed`. It has not been dispatched.
3. Tony approves it in the dashboard, moving it to `ready`.
4. Tony assigns an agent. Human ownership and agent delegation remain separate.
5. The assigned agent calls `start_work_run`, optionally linking its provider session
   and Agent Bus thread.
6. The agent records status and provider-reported usage with `update_work_run`.
7. The agent submits evidence and deliverables with `submit_work_receipt`.
8. Work with no gate finishes. Human- or independent-agent-gated work enters `review`
   and only finishes after `review_work_item` approves it.

The dashboard provides Overview, Tasks, Agents, Reviews, Usage and Routes views.
Agent availability is derived from active assignments rather than manually asserted.

## Status model

### Outcome-contract integrity

- Unknown provider usage is stored as `null`, never inferred as zero. Zero is valid only
  when a provider explicitly reports zero. Aggregate usage stays unknown while any included
  run is unknown and exposes an `unknown_runs` count.
- Every completion receipt supplies at least one structured evidence claim with
  `target_state` (what is now true), `location` (where to inspect it), and `verify` (an exact
  read-only verification command or procedure). Process exit alone is not evidence.
- Proposal creation computes a normalized intent signature and compares it with open work.
  A likely replay is retained as a canceled audit record pointing to the accepted item.
  `duplicate_override: true` is the explicit escape hatch for legitimately repeated work.
- `npm run state:lint` deterministically reports active runs beneath terminal/review work,
  stale active runs, ambiguous historical zero usage, and stale non-terminal threads.
  `AGENT_BUS_STATE_STALE_HOURS` controls the stale threshold (default 24 hours).

Work item states are deliberately small:

```text
proposed -> ready -> in_progress -> review -> done
                         |            |
                         v            v
                       blocked ----> in_progress
```

`canceled` is terminal. `done` requires a receipt and any configured review gate.

Runs retain provider detail without making provider sessions authoritative:

```text
queued -> dispatched -> acknowledged -> running
                                      -> waiting_input
                                      -> blocked
                                      -> submitted
                                      -> completed / failed
```

## Runtime files

The configured `AGENT_BUS_ROOT` contains both stores:

```text
AgentBus/
  inbox/
  threads/
  shared/
  archive/
  work-ledger/
    items/
      work_<id>/
        work-item.md
        events.jsonl
        receipt.md
```

Work items and receipts are readable Markdown with YAML frontmatter. Events are
append-only JSON Lines. The dashboard is a view over these files, not a second store.
Raw model reasoning is not recorded.

## A6 and host-local agents

The intended deployment is split by responsibility:

| Location | Responsibility |
|---|---|
| A6 | Authoritative Work Ledger files, dashboard, JSON API, health/version and logs |
| Mac | Codex Desktop/CLI, Cursor and Antigravity adapters and their native sessions |
| Either | Headless Claude/Codex workers when the job does not need desktop state |

The A6 deployment paths are:

```text
/srv/projects/Personal/agent-bus/app       # deployed source checkout
/srv/projects/Personal/agent-bus/runtime   # durable Agent Bus and ledger records
~/var/log/home-platform/agent-bus/         # structured logs
```

The service is registered on `127.0.0.1:8091`, with the private reverse-proxy base
path `/agent-bus`. It does not expose a public Cloudflare route.

Local MCP clients point work operations at the same authority:

```text
AGENT_BUS_CONTROL_PLANE_URL=http://127.0.0.1:18091/agent-bus
```

Port `18091` is the Mac end of the private A6 SSH tunnel in the initial deployment.
The later Caddy/Tailscale route can replace that tunnel without changing the API.

## Container operation on A6

The checked-in Compose deployment uses host networking so the container can bind
the host's `127.0.0.1` directly. It drops Linux capabilities, uses a read-only root
filesystem and mounts only runtime data and the standard platform log directory.

```bash
docker compose up -d --build
curl http://127.0.0.1:8091/healthz
curl http://127.0.0.1:8091/version
```

If a write token is enabled, obtain it from 1Password at service start and set
`AGENT_BUS_WRITE_TOKEN` in memory. Never commit it or put it in an environment file.

## Deliberately deferred

The first release does not autonomously dispatch arbitrary jobs, upload Mac-local
artifacts to A6, infer costs, store chain-of-thought, or replace the Knowledge Vault,
software backlog or GitHub as the source of human work. Those capabilities need
evidence from the shadow-ledger phase before promotion.
