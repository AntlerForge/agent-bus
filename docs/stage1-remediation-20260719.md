# Stage 1 remediation record — 2026-07-19

## Mac LaunchAgents

Root cause: launchd had not suffered one shared die-off. Three jobs had successful current
run counters; the share mount had not run after its current bootstrap. The sentinel inferred
failure from stale stdout/stderr files, but direct commands bypassed those files and the
project-store job launches a GUI helper whose real outcome is written to a separate bridge
log. The shared defect was therefore observability: log mtime was not semantic completion.

The share mount, runtime check and developer-mirror jobs now execute through
`scripts/outcome-truth-launchagent-wrapper.sh`, which atomically records command completion
and exit status. Project-store continues through its Full-Disk-Access helper and is observed
from the helper's `bridge end rc=...` record. Original plists are preserved under
`~/Library/LaunchAgents/.w1-remediation-backup-20260719/`; restoring those files and
bootout/bootstrap reverses the change.

## Authority and backup

The MCP server requires the A6 control-plane URL and permits local storage only through the
explicit `AGENT_BUS_ALLOW_LOCAL=1` development opt-in. The two misrouted items remain in
`~/AgentBus/_misrouted-quarantine-20260719/` with their audit note.

Tony approved retirement of the 02:00 rsync cron job. Its script and retirement note are
preserved on A6 under `runtime/retired/legacy-rsync-20260719/`. Hourly Borg now declares
`/share` and `/srv` in full, plus the existing `/etc` configuration sources. The sentinel
closes the historical rsync card only when replacement coverage is declared and Borg is fresh.

## KV repair

No KV application code or schema changed. Canonical skill/app mirrors were reconciled,
the app-only test was archived in the existing deploy-backup area, two invalid task visibility
values and one detached task-table row were repaired, and Doctor now has zero failing checks.
Warning-class hygiene findings remain visible and are not misrepresented as hard failures.
