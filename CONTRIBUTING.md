# Contributing

Contributions are welcome, with the caveat that this is maintained around a full-time
job. Small, focused changes are easiest to review.

## Development Setup

```bash
git clone https://github.com/AntlerForge/agent-bus.git
cd agent-bus
npm ci
npm test
```

For local runtime testing:

```bash
AGENT_BUS_ROOT="$(mktemp -d)" ./setup.sh
npm test
```

## Project Principles

- Keep the bus local-first and inspectable.
- Store durable state as plain files where practical.
- Prefer explicit message/thread status over hidden automation.
- Keep the shared artifact model simple: files must live under `AGENT_BUS_ROOT/shared`.
- Avoid embedding personal paths, private data, or machine-specific assumptions.

## Pull Requests

Before opening a pull request:

- run `npm test`;
- update docs when changing setup, tools, or message behavior;
- keep unrelated refactors out of feature or bug-fix PRs;
- avoid committing runtime mailbox data, local config, screenshots, generated artifacts,
  or `node_modules`.
