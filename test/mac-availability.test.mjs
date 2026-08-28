import test from "node:test";
import assert from "node:assert/strict";
import { deriveMacAvailability } from "../src/outcome-truth/mac-availability.mjs";

test("24h absent Mac is offline without inventing a new last-seen", () => {
  const result = deriveMacAvailability({
    now: "2026-08-28T08:00:00Z", peerOnline: false,
    reportObservedAt: "2026-08-27T08:00:00Z",
    previous: { mac_state: "online", mac_last_seen: "2026-08-27T08:00:00Z" },
  });
  assert.equal(result.mac_state, "offline");
  assert.equal(result.mac_last_seen, "2026-08-27T08:00:00Z");
  assert.equal(result.reconciliation, null);
});

test("first fresh report after offline creates exactly one reconciliation", () => {
  const previous = { mac_state: "offline", offline_since: "2026-08-27T08:00:00Z", mac_last_seen: "2026-08-27T07:58:00Z" };
  const first = deriveMacAvailability({ now: "2026-08-28T08:00:00Z", peerOnline: true, reportObservedAt: "2026-08-28T07:59:00Z", previous });
  assert.equal(first.mac_state, "sporadic");
  assert.equal(first.reconciliation.state, "pending");
  const second = deriveMacAvailability({ now: "2026-08-28T08:05:00Z", peerOnline: true, reportObservedAt: "2026-08-28T08:04:00Z", previous: first });
  assert.equal(second.reconciliation.id, first.reconciliation.id);
});
