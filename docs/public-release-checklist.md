# Public Release Checklist

Before making the repository public:

- [ ] `npm test` passes.
- [ ] `node src/server.mjs` starts under a temporary `AGENT_BUS_ROOT`.
- [ ] `node src/codex-bridge.mjs --once --root <tmp> --codex-command <fake-codex>` path is covered by tests.
- [ ] No personal absolute paths remain in tracked source, docs, or skills.
- [ ] `node_modules/`, `.env`, `.agent-bus.local.json`, runtime mailbox data, logs, and shared artifacts are ignored.
- [ ] The live runtime mailbox, usually `~/AgentBus`, is not inside the repo and is not committed.
- [ ] Any screenshots or demo artifacts are deliberate examples, not private working files.
- [ ] `README.md` and `docs/setup.md` describe generic setup.
- [ ] License file is present and `package.json` license matches it.
- [ ] GitHub Actions test workflow is present.
- [ ] `SECURITY.md`, `SUPPORT.md`, and `CONTRIBUTING.md` are present.
- [ ] A clean clone can run `./setup.sh` and `npm test`.

Useful checks:

```bash
npm test
git status --short --ignored
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' \
  '<your-name>|<absolute-user-path>|AgentBus/shared/.*(draft|private)' .
```
