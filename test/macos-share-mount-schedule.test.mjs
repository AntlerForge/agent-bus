import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const plistPath = "deploy/macos/com.antlerforge.a6-share-mount.plist.example";

test("A6 share mount uses a ten-minute calendar cadence with wake catch-up", async () => {
  const plist = await fs.readFile(plistPath, "utf8");
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>StartCalendarInterval<\/key>/);
  assert.doesNotMatch(plist, /<key>StartInterval<\/key>/);
  assert.doesNotMatch(plist, /<key>Hour<\/key>/);
  const minutes = [...plist.matchAll(/<key>Minute<\/key><integer>(\d+)<\/integer>/g)].map((match) => Number(match[1]));
  assert.deepEqual(minutes, [0, 10, 20, 30, 40, 50]);
});
