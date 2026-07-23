import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const inventory = YAML.parse(await fs.readFile("config/critical-assets.v1.yaml", "utf8"));

test("critical-asset inventory names every Stage 3 recovery domain and flags gaps", () => {
  const ids = new Set(inventory.assets.map((asset) => asset.id));
  for (const id of ["a6-vault", "a6-project-store", "agent-bus-ledger-runtime", "a6-human-share", "mac-developer-working-copies", "home-assistant-config", "workshop-pc-backups"])
    assert.ok(ids.has(id), id);
  assert.ok(inventory.assets.every((asset) => asset.protection && asset.status));
  const unprotected = inventory.assets.filter((asset) => asset.status === "unprotected");
  assert.deepEqual(unprotected.map((asset) => asset.id), ["home-assistant-config"]);
  assert.ok(unprotected.every((asset) => asset.gap));
});
