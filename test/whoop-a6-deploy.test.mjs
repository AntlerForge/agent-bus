import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("WHOOP daily deployment is A6-persistent and writes the canonical vault", async () => {
  const [service, timer, runner] = await Promise.all([
    fs.readFile("deploy/a6/whoop-daily/whoop-daily.service", "utf8"),
    fs.readFile("deploy/a6/whoop-daily/whoop-daily.timer", "utf8"),
    fs.readFile("deploy/a6/whoop-daily/run-whoop-daily", "utf8"),
  ]);
  assert.match(timer, /OnCalendar=.*08:05:00 Europe\/London/);
  assert.match(timer, /Persistent=true/);
  assert.match(service, /User=ajbarfoot/);
  assert.match(service, /ReadWritePaths=\/srv\/kv\/vault/);
  assert.match(runner, /WHOOP_VAULT:-\/srv\/kv\/vault/);
  assert.match(runner, /whoop-last-success/);
});
