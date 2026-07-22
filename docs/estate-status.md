# Estate Status

Estate Status is the durable human-readable landing page for Agent Bus alerts.
It is regenerated after every outcome-sentinel and decision-queue evaluation.

Bookmark the same private URL on Mac, iPhone and iPad:

`http://antler-a6:8088/Projects/Personal/agent-bus/runtime/estate-status/estate-status.md`

Access remains protected by the tailnet and FileBrowser login. There is no public
route. The page shows current open exception cards, queue headline metrics, the
latest breach summary and decision pack, and the most recent 20 alerts with their
current recovery state.

Notification URLs must never target JSON. Queue breach alerts target the rendered
`breach-summary.md`; pack announcements target the rendered pack; other messages
default to Estate Status.
