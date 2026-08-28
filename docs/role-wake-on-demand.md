# On-demand persistent-role seating

The Agent Bus `wake_role` MCP tool queues a fresh bounded seating for
`coherence-manager`, `estate-operations-manager`, or `estate-architect`. `tony`,
`chief-of-staff`, and `estate-operations-manager` may each wake any role. The control plane
binds requester identity to a distinct owner-only credential; the MCP tool does not accept
caller-supplied identity. Worker and monitor credentials have separate, narrower scopes and
cannot call the wake route. The durable `_role-seats.json` record on A6 is
the occupancy authority; agent `last_seen` and bridge heartbeats are deliberately ignored.

The Mac LaunchAgent runs `scripts/role-wake-worker.mjs` once per minute. It atomically
claims pending wakes, records fenced occupied seats, and concurrently starts fresh Codex
sessions in the roles' seating desks. It records the exact child PID plus a one-use process
marker, heartbeats the seat generation, and records unseat success or failure. A later
same-host worker can recover an expired seat only after the old worker PID is dead and the
exact marker-bearing child has been stopped and verified dead. The role prompt requires the
canonical skill, wake ritual, role ledger update, and charter boundary. The spawning role
does not hold the woken seat and no provider suffix is added to the identity.

If the seat is already occupied, the wake call returns `occupied_noop` with the current
seat, appends a note event, and puts a durable idempotent note into a retrying outbox for the
occupant. It never creates a second session. A second pending request
is similarly idempotent.

`agent-bus-role-attention.timer` evaluates the A6 authority every five minutes. It signals
an immediate EOM seating when response-required unread messages, waiting runs or pending
reviews exceed the EOM-owned thresholds, and otherwise requests the configured few-hourly
EOM patrol. Repeated signatures are suppressed for one patrol interval. Signals never notify
Tony, mutate work state or wake another role; alerting policy v1 is unchanged.

The patrol clock advances only when the fenced EOM seat explicitly calls
`complete_role_attention_pass` after handling its monitor-owned queue. A normal process exit is
not treated as proof. Any signal attached to the seat, or delivered during it, that remains
unhandled at unseat creates one follow-up request.

The EOM-owned operating contract is: 4h unread-response threshold for active recipients, 4h
waiting-run threshold unless a declared later gate applies, 24h from the current review-entry
transition, and a maximum 4h between completed monitor-owned EOM passes. Findings are keyed per
breach episode, newly breached episodes are coalesced, retries are idempotent, resolved findings
do not wake anyone, and a clear-then-rebreach transition creates a new episode. The monitor
snapshot is `_role-attention-monitor.json`; it records effective settings, active/new findings,
pending and last signals, last successful evaluation, the last completed attention seat, and the
next patrol due time. `agent-bus-role-attention-health.timer` fails visibly if either the snapshot
or Mac worker heartbeat is more than 15 minutes old.

Operations runbook (A6):

```sh
systemctl status agent-bus-role-attention.timer agent-bus-role-attention.service
systemctl status agent-bus-role-attention-health.timer agent-bus-role-attention-health.service
systemctl cat agent-bus-role-attention.service
journalctl -u agent-bus-role-attention.service -u agent-bus-role-attention-health.service --since today
jq . /srv/projects/Personal/agent-bus/runtime/_role-attention-monitor.json
jq '{worker,attention,seats,signals}' /srv/projects/Personal/agent-bus/runtime/_role-seats.json
cd /srv/projects/Personal/agent-bus/app && node --test test/role-attention.test.mjs
```

The evaluator library is the read-only/dry-run surface: import and call
`evaluateRoleAttention()` without invoking the monitor script. For recovery, inspect the exact
seat generation, worker heartbeat and session PID/token fence before allowing the Mac worker to
recover it. To reverse automatic attention wakes while keeping manual `wake_role`, disable only
`agent-bus-role-attention.timer`; records and credentials remain intact.

Credentials are generated once with `scripts/provision-role-wake-credentials.mjs`. The A6
control plane receives only SHA-256 token digests. Each caller receives only its own token;
the Mac worker receives its worker token and the EOM token needed by a woken EOM child. Files
are mode 0600 and are not committed.

Bounded role sessions retain workspace-write filesystem isolation but explicitly receive
network access so their sanctioned Agent Bus MCP transport and A6 authority paths work. This
does not enlarge the role charter; it removes a transport contradiction that otherwise leaves
the seat occupied while preventing its required ledger and queue updates.

Deployment copies the plist example to `~/Library/LaunchAgents/`, substitutes only paths if
needed, validates it with `plutil`, bootstraps it into the user domain, then verifies both a
queued request and a completed seat/unseat record. Reversal boots out that LaunchAgent;
durable seat history remains readable on A6.
