# On-demand persistent-role seating

The Agent Bus `wake_role` MCP tool queues a fresh bounded seating for
`coherence-manager`, `estate-operations-manager`, or `estate-architect`. Only `tony` and
`chief-of-staff` are accepted as requesters and their matching trusted-policy authority is
validated by the server. The durable `_role-seats.json` record on A6 is
the occupancy authority; agent `last_seen` and bridge heartbeats are deliberately ignored.

The Mac LaunchAgent runs `scripts/role-wake-worker.mjs` once per minute. It atomically
claims pending wakes, records fenced occupied seats, and concurrently starts fresh Codex
sessions in the roles' seating desks. It heartbeats each seat and records unseat success or
failure. A later same-host worker recovers an expired seat left by a crashed predecessor
before claiming its replacement. The role prompt requires the
canonical skill, wake ritual, role ledger update, and charter boundary. The spawning role
does not hold the woken seat and no provider suffix is added to the identity.

If the seat is already occupied, the wake call returns `occupied_noop` with the current
seat, appends a note event, and delivers a durable Agent Bus note to the occupant. It never creates a second session. A second pending request
is similarly idempotent. Wake-on-message is not enabled in this first tier.

Deployment copies the plist example to `~/Library/LaunchAgents/`, substitutes only paths if
needed, validates it with `plutil`, bootstraps it into the user domain, then verifies both a
queued request and a completed seat/unseat record. Reversal boots out that LaunchAgent;
durable seat history remains readable on A6.
