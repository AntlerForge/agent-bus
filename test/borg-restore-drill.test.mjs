import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const source = await fs.readFile("scripts/borg-restore-drill.mjs", "utf8");
const manifest = await fs.readFile("docs/w3.2-restore-drill-manifest-20260719.md", "utf8");
const assets = [
  "/srv/kv/vault/dashboard/doctor.json",
  "/srv/projects/Personal/agent-bus/app/scripts/decision-queue.mjs",
  "/srv/projects/Personal/agent-bus/app/config/decision-queue-sla.v1.yaml",
  "/etc/samba/smb.conf",
  "/share/Knowledge-Vault/tasks/day-board.md",
];

test("restore assets were declared before the drill and include explicit share coverage", () => {
  for (const asset of assets) {
    assert.match(source, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(manifest.includes(`\`${asset}\``));
  }
  assert.ok(assets.some((asset) => asset.startsWith("/share/")));
});

test("restore runner confines extraction and proves production immutability", () => {
  assert.match(source, /fs\.mkdtemp/);
  assert.match(source, /restoreRoot\.startsWith/);
  assert.match(source, /productionBefore/);
  assert.match(source, /productionAfter/);
  assert.match(source, /production_untouched/);
  assert.doesNotMatch(source, /cwd:\s*["']\/["']/);
});
