# Outcome-truth sentinel

The A6 sentinel evaluates `config/outcome-truth-matrix.v1.yaml` every 15 minutes and stores
inspectable cards under `/srv/projects/Personal/agent-bus/runtime/outcome-truth` (directory
0700, files 0600). Cards have stable matrix/check ids, deduplicate recurrence, and close only
when the declared semantic recovery condition passes.

The first 14 days are shadow mode: all cards are recorded, but only failures whose first
observation is after deployment produce live ALERTs. Recovery transitions produce ALERT-class
recovery notices. A daily run with `OUTCOME_DAILY_INFO=1` emits one INFO only when all enabled
checks pass. Sentinel code contains no APPROVAL path.

Mac state is obtained by one LaunchAgent running `scripts/outcome-truth-mac-probe.mjs` and
atomically copying the snapshot over the existing outbound private SSH relationship. The probe
reads log mtimes and `/Volumes/share`; it changes no monitored state. Unload and delete
`com.antlerforge.agent-bus-outcome-reporter.plist` to reverse the Mac footprint; remove the two
A6 timers/services and runtime directory to reverse A6 deployment.

The independent dead-man timer reads only the heartbeat and calls the HA notifier directly.
It neither invokes nor imports the sentinel evaluator. SpanielBus slots are reserved and
disabled; van-offline failures and Home Assistant entity availability are deliberately ignored.

The daily-synthesis contract reads the authoritative automation run ledger and passes only when
the latest terminal event is `run_completed`; `run_warning` remains failed even when a process
exited normally. The legacy rsync contract reads the most recent recorded rsync code rather than
trusting the later `backup complete` message.
