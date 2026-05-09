# Security Policy

Agent Bus is local-first software. It does not run a hosted service, but it does let
local agent processes exchange messages and references to files. Treat every connected
agent as a local actor with the permissions you grant to its host application.

## Supported Versions

The `main` branch is the supported development version until formal releases are cut.

## Security Model

- Runtime data is stored under `AGENT_BUS_ROOT`, which defaults to `~/AgentBus`.
- Shared artifacts must be inside the runtime `shared/` directory before they can be
  registered.
- Basic secret-pattern checks block obvious private keys and common API token shapes in
  messages, but this is a guardrail, not a data-loss-prevention system.
- Agent Bus does not authenticate local clients. Only configure it for local tools and
  accounts you already trust.

## Safe Use

- Keep `AGENT_BUS_ROOT` outside synced folders such as iCloud Drive, Dropbox, or Google
  Drive unless you intentionally want mailbox contents synced.
- Do not put secrets, credentials, private keys, or confidential documents in messages.
- Use the `shared/` folder only for files you are comfortable exposing to every connected
  agent with access to that runtime mailbox.
- Review generated shell commands before running them, especially commands suggested by
  another model through the bus.
- Grant agent hosts access only to the project folder and runtime mailbox folder they
  need.

## Reporting A Vulnerability

Please open a GitHub issue with enough detail to reproduce the problem. If public
disclosure would expose a working secret or a serious local-execution risk, open a minimal
issue saying you have a security report and avoid posting the sensitive details directly.

This is a small personal project, so response times may vary.
