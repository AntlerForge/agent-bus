# On-demand persistent-role seating

The Agent Bus `wake_role` MCP tool queues a fresh bounded seating for
`coherence-manager`, `estate-operations-manager`, or `estate-architect`. Only `tony` and
`chief-of-staff` are accepted as requesters. The durable `_role-seats.json` record on A6 is
the occupancy authority; agent `last_seen` and bridge heartbeats are deliberately ignored.

The Mac LaunchAgent runs `scripts/role-wake-worker.mjs` once per minute. It atomically
claims one pending wake, records the occupied seat, starts a fresh Codex session in the
role's seating desk, and records unseat success or failure. The role prompt requires the
canonical skill, wake ritual, role ledger update, and charter boundary. The spawning role
does not hold the woken seat and no provider suffix is added to the identity.

If the seat is already occupied, the wake call returns `occupied_noop` with the current
seat and appends a note event. It never creates a second session. A second pending request
is similarly idempotent. Wake-on-message is not enabled in this first tier.

Deployment copies the plist example to `~/Library/LaunchAgents/`, substitutes only paths if
needed, validates it with `plutil`, bootstraps it into the user domain, then verifies both a
queued request and a completed seat/unseat record. Reversal boots out that LaunchAgent;
durable seat history remains readable on A6.
