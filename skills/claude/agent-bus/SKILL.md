---
name: agent-bus
description: Use when an agent needs to coordinate with another agent through Tony's Agent Bus, A6 control plane or Agent Work Ledger; create or process delegated work; use model-routing guidance; manage messages, runs, receipts, reviews or token usage; establish or verify a provider bridge; or distinguish a registered agent, accessible model surface and genuinely connected session.
---

# Agent Bus

Use Agent Bus as Tony's durable coordination rail, not as another model runtime.

## System boundary

- **Agent Bus** owns messages, delivery, acknowledgements, threads and artifact references.
- **Agent Work Ledger** owns proposals, approval, assignment, runs, receipts, reviews and recorded usage.
- **Model selector** supplies advisory model, surface and workflow guidance. It never dispatches work.
- **Provider bridge** connects a specific native session to the bus and should resume that session when persistence matters.
- **Source system** such as KV, a software backlog or GitHub remains authoritative; link it with `source_ref`.

Never collapse these distinctions:

- A registered agent identity is not proof that its adapter is running.
- An `available` model surface means Tony can access that app or service; it is not a live Agent Bus bridge.
- Dashboard agent status is derived from assignments and runs, not a transport-health guarantee.
- A proposal is not approved, assigned or dispatched.
- A delivered message is not a completed work item.
- `provider_session_ref` records native context continuity; it does not make the provider session task authority.

## Tony's deployment

- Control plane and authoritative runtime: A6, `/srv/projects/Personal/agent-bus/`.
- Dashboard from the Mac: `http://127.0.0.1:18091/agent-bus/` through the private SSH tunnel.
- A6 service: `127.0.0.1:8091`, base path `/agent-bus`.
- Mac-hosted MCP clients should set:
  `AGENT_BUS_CONTROL_PLANE_URL=http://127.0.0.1:18091/agent-bus`.
- `~/AgentBus` is only an explicit local-development fallback. Never silently create a second durable ledger when A6 is expected.

### Connected task targets

Use these exact Agent Bus addresses:

| Target | Native surface | Current default | Persistence |
|---|---|---|---|
| `codex` | Codex CLI bridge | `gpt-5.6-sol` | dedicated persistent bridge session |
| `cursor` | Cursor Agent CLI bridge | Grok 4.5 High | one Cursor session per bus thread |
| `antigravity` | Antigravity `agy` bridge | Gemini 3.5 Flash Medium | one conversation per bus thread |
| `claude-code` | Claude Code channel | model chosen in that session | only while the channel session is open |

Codex, Cursor and Antigravity bridges are persistent Mac LaunchAgents and should heartbeat
into A6. Model labels are not bus identities: Fable and Grok are Cursor model choices, so
send to `cursor`; Gemini is selected behind `antigravity`. Never use computer-use to paste
tasks into those apps while their headless bridges are healthy.

Use Agent Bus MCP tools first. If they are absent, use the A6 control-plane API or project modules only when the current host and requested workflow make that safe. Never mutate A6 runtime files directly.

## Start with discovery

Before promising a handoff:

1. Call `list_agents` to inspect registered identities and `last_seen` where present.
2. Call `get_model_selector` when the choice of model or surface matters.
3. Check whether the target has a real bridge or worker, not merely an identity or accessible surface.
4. Confirm the bridge can reach or resume the intended provider-native session when persistent context is required.
5. If delivery has not been proven, describe the target as **unconnected** or **manual handoff required**.

A stale or null `last_seen` does not prove a bridge is live. A recent registration is useful evidence but an acknowledgement or current adapter health is stronger.

When local project tools are available, verify all persistent bridges and artifact handoff
with:

```bash
cd ~/Developer/personal/agent-bus
npm run bridge:test -- --target codex --target cursor --target antigravity --artifact
```

Passing evidence requires acknowledgement, a reply containing the artifact nonce on the
same thread, and thread status `completed` for every target.

## Choose the right workflow

### Message or consultation only

Use a message when no governed task lifecycle is needed:

1. Put large material in stable files and pass absolute paths through `artifact_paths`; the remote client uploads supported Mac-local files to A6 before delivery.
2. Call `send_message` with explicit `from`, `to`, subject, body and intent
   (`inform`, `consult`, `recommendation` or `execute`). `execute` also requires
   the current assignment authority or a named trusted policy.
3. Set `requires_response: true` only for a question, review request or delegated action.
4. Set `ack_required: true` only when receipt must be demonstrated.
5. Report the `message_id` and `thread_id`.

For a taskable target, sending is enough: do not separately create or open a provider app
chat. The running bridge acknowledges the message, materializes its artifacts, executes on
the configured native CLI, replies in the same thread and updates transport status.

### Governed delegated work

Use the Work Ledger when status, approval, budget, review or usage matters:

1. Freeze the input and rubric. Give them stable `source_ref` and `context_ref` values.
2. Call `propose_work_item`, or call `propose_routing_workflow` for an approved selector template.
3. Leave every new item in `proposed`. Tony approves it to `ready` and assigns an agent in the dashboard.
4. After assignment, send the delivery message and retain its `thread_id`.
5. Call `start_work_run` as the assigned agent, recording provider, `provider_session_ref` and `thread_id` when known.
6. Call `update_work_run` for meaningful status changes and provider-reported token/cost usage.
7. Call `submit_work_receipt` with outcome, summary, evidence, deliverables, limitations and known usage.
8. If a gate applies, leave the item in review until `review_work_item` records approval or requests changes.

Agents may propose work and operate work assigned to them. They must not approve their own proposal, assign themselves, bypass a review gate or claim unknown usage.

### Independent review panel

For genuinely independent reviews:

1. Give every reviewer the identical frozen artifact and rubric.
2. Use distinct provider independence groups where the selector supplies them.
3. Do not reveal another reviewer's findings before each receipt is submitted.
4. Ask reviewers to diagnose against the rubric; do not allow silent rewriting when the task is review.
5. Keep separate work items or runs so evidence and token usage remain attributable.
6. Synthesize only after the independent receipts exist.

## Process inbound work

For an actionable inbound message:

1. Read the message and linked thread/work item.
2. Call `ack_message` when acknowledgement is requested.
3. Confirm the work item is assigned to this agent before starting a governed run.
4. Start or resume the provider-native session and record the session reference.
5. Perform the work, updating run status only at meaningful transitions.
6. Reply in the same thread when a response is required.
7. Submit the work receipt when an outcome exists.
8. Call `mark_read` and update message-thread status without confusing it with ledger status.

For informational messages with `requires_response: false`, do not create a reply loop.

## Persistence

Agent Bus persists coordination records, not the model's whole conversational context. To talk to the same agent later:

- keep a stable agent identity;
- retain `provider_session_ref` on the run;
- configure the bridge to resume that native session;
- keep durable facts and artifacts in the source system or referenced files;
- create a new run when the same work item legitimately resumes.

If the provider cannot resume a session, create a new session and rehydrate it from the frozen context packet. Record the new session reference; do not pretend continuity.

## Dashboard interpretation

The dashboard exposes Overview, Tasks, Agents, Model routes, Reviews, Usage and Messages.

- **Tasks:** proposal, approval, assignment and work-item detail.
- **Agents:** workload-derived directory; not a live connection monitor.
- **Model routes:** selector recommendations and templates; `Set up review panel` creates proposals only.
- **Reviews:** human or independent-agent gates awaiting decisions.
- **Usage:** provider-reported tokens and known cost; missing cost stays unknown.
- **Messages:** transport threads, separate from work status.

When operating through the dashboard on Tony's behalf, preserve the same authority boundaries as MCP: do not approve, assign or dispatch unless Tony explicitly requested that action.

## Failure and reporting discipline

- If the A6 control plane is expected but unreachable, report that exact failure and do not fall back to a hidden local ledger.
- If a bridge is unavailable, keep the work proposed/ready and state whether manual delivery or adapter setup is required.
- If delivery is uncertain, do not mark a run acknowledged or completed.
- If token or cost data is unavailable, record it as unknown rather than estimating silently.
- Do not mark work complete until a receipt exists and every configured review gate has passed.

Report identifiers that let Tony follow the audit trail: work item, run, message/thread, target agent/surface, provider session, current status and next required human action.
