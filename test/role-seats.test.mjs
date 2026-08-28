import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claimRoleWake, readRoleSeats, requestRoleWake, unseatRole } from "../src/role-seats.mjs";

test("role wake records occupancy and occupied wake is a safe no-op", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "role-seat-"));
  const queued = await requestRoleWake({ role: "coherence-manager", requested_by: "chief-of-staff", reason: "review queue" }, root);
  assert.equal(queued.disposition, "queued");
  const claimed = await claimRoleWake({ worker_id: "worker", host: "mac" }, root);
  assert.equal(claimed.seat.who, "coherence-manager");
  assert.equal(claimed.seat.where, "mac");
  const noop = await requestRoleWake({ role: "coherence-manager", requested_by: "tony", reason: "second" }, root);
  assert.equal(noop.disposition, "occupied_noop");
  await unseatRole({ role: "coherence-manager", seat_id: claimed.seat.seat_id }, root);
  assert.equal((await readRoleSeats(root)).seats["coherence-manager"].status, "unseated");
});

test("role wake rejects provider identities and unsanctioned callers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "role-seat-"));
  await assert.rejects(requestRoleWake({ role: "coherence-manager-codex", requested_by: "chief-of-staff", reason: "x" }, root), /role must be/);
  await assert.rejects(requestRoleWake({ role: "coherence-manager", requested_by: "codex", reason: "x" }, root), /requested_by/);
});
