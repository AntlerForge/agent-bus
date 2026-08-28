import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const plistPath = "deploy/macos/com.antlerforge.a6-share-mount.plist.example";
const reporterPlistPath = "deploy/macos/com.antlerforge.agent-bus-outcome-reporter.plist.example";

test("A6 share mount uses a ten-minute calendar cadence with wake catch-up", async () => {
  const plist = await fs.readFile(plistPath, "utf8");
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(
    plist,
    /<key>KeepAlive<\/key>[\s\S]*<key>PathState<\/key>[\s\S]*<key>\/Volumes\/share<\/key>\s*<false\/>/,
  );
  assert.match(plist, /<key>StartCalendarInterval<\/key>/);
  assert.doesNotMatch(plist, /<key>StartInterval<\/key>/);
  assert.doesNotMatch(plist, /<key>Hour<\/key>/);
  const minutes = [...plist.matchAll(/<key>Minute<\/key><integer>(\d+)<\/integer>/g)].map((match) => Number(match[1]));
  assert.deepEqual(minutes, [0, 10, 20, 30, 40, 50]);
});

test("Mac outcome reporter samples after, never during, a share-mount repair minute", async () => {
  const mountPlist = await fs.readFile(plistPath, "utf8");
  const reporterPlist = await fs.readFile(reporterPlistPath, "utf8");
  const minutes = (plist) => [...plist.matchAll(/<key>Minute<\/key><integer>(\d+)<\/integer>/g)]
    .map((match) => Number(match[1]));

  const mountMinutes = minutes(mountPlist);
  const reporterMinutes = minutes(reporterPlist);
  assert.deepEqual(reporterMinutes, [2, 17, 32, 47]);
  assert.equal(reporterMinutes.some((minute) => mountMinutes.includes(minute)), false);
  assert.equal(reporterMinutes.every((minute) => {
    const elapsedSinceMount = Math.min(...mountMinutes.map((mountMinute) => (minute - mountMinute + 60) % 60));
    return elapsedSinceMount >= 2;
  }), true);
});

test("Mac runtime check gets one bounded delayed retry for wake-network convergence", async () => {
  const plist = await fs.readFile("deploy/macos/com.antlerforge.kv-mac-runtime-check.plist.example", "utf8");
  const wrapper = await fs.readFile("scripts/outcome-truth-launchagent-wrapper.sh", "utf8");
  assert.match(plist, /<key>OUTCOME_MAX_ATTEMPTS<\/key>\s*<string>2<\/string>/);
  assert.match(plist, /<key>OUTCOME_RETRY_DELAY_SECONDS<\/key>\s*<string>15<\/string>/);
  assert.match(wrapper, /attempt >= max_attempts/);
  assert.match(wrapper, /retry_delay_seconds \* attempt/);
});

test("Developer-mirror sync gets the same bounded wake-network retry", async () => {
  const plist = await fs.readFile("deploy/macos/com.antlerforge.kv-developer-mirrors-sync.plist.example", "utf8");
  assert.match(plist, /<key>OUTCOME_MAX_ATTEMPTS<\/key>\s*<string>2<\/string>/);
  assert.match(plist, /<key>OUTCOME_RETRY_DELAY_SECONDS<\/key>\s*<string>15<\/string>/);
});
