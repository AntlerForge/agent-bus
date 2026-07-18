# Home Assistant notifier

`scripts/ha-notify-tony.mjs` is the A6 entry point for `ALERT`, `APPROVAL`, and
`INFO` notifications. Stable IDs are claimed atomically under
`/srv/projects/Personal/agent-bus/runtime/ha-notify/sends`; replaying an ID
returns the original result with `deduplicated: true` and sends nothing.

APPROVAL notifications contain one-tap YES and NO actions. The A6 listener
subscribes to `mobile_app_notification_action` and writes the decision to
`runtime/ha-notify/responses/<base64url-id>.json` for the control plane to read.
On iOS the buttons are revealed by pressing and holding the notification (or
swiping left and choosing View on the Lock Screen); the approval subtitle states
this explicitly. Category registration is not required for modern inline actions.

Secrets are not copied into this repository. Both processes read Tony's existing
`~/Developer/ha-agent-pilot/.env` on A6, which must be owned by `ajbarfoot` and
mode `0600`. Notification targets live in the non-secret, runtime-only
`runtime/ha-notify/config.json`, also mode `0600`.

Example:

```bash
node scripts/ha-notify-tony.mjs --class APPROVAL --approval-number 1 \
  --id stage0-live-approval-1 --message 'APPROVAL 1: Confirm Stage 0 HA round-trip?'
```

HA-side changes: none. Reversal is disabling/removing the A6 listener unit and
removing the runtime notifier directory; no Home Assistant configuration is
modified.
