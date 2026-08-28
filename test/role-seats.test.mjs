import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claimRoleWake, readRoleSeats, recoverStaleRoleSeats, requestRoleWake, unseatRole } from "../src/role-seats.mjs";
import { readInbox } from "../src/mailbox.mjs";

const cosAuthority = { type: "trusted_policy", policy_id: "chief-of-staff-relay" };
const tonyAuthority = { type: "trusted_policy", policy_id: "tony-direct-instruction" };

test("role wake records occupancy and occupied wake is a safe no-op", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "role-seat-"));
  const queued = await requestRoleWake({ role: "coherence-manager", requested_by: "chief-of-staff", reason: "review queue", execution_authority: cosAuthority }, root);
  assert.equal(queued.disposition, "queued");
  const claimed = await claimRoleWake({ worker_id: "worker", host: "mac" }, root);
  assert.equal(claimed.seat.who, "coherence-manager");
  assert.equal(claimed.seat.where, "mac");
  const noop = await requestRoleWake({ role: "coherence-manager", requested_by: "tony", reason: "second", execution_authority: tonyAuthority }, root);
  assert.equal(noop.disposition, "occupied_noop");
  assert.match((await readInbox({ agent: "coherence-manager" }, root))[0].body, /suppressed/);
  await unseatRole({ role: "coherence-manager", seat_id: claimed.seat.seat_id }, root);
  assert.equal((await readRoleSeats(root)).seats["coherence-manager"].status, "unseated");
});

test("role wake rejects provider identities and unsanctioned callers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "role-seat-"));
  await assert.rejects(requestRoleWake({ role: "coherence-manager-codex", requested_by: "chief-of-staff", reason: "x", execution_authority: cosAuthority }, root), /role must be/);
  await assert.rejects(requestRoleWake({ role: "coherence-manager", requested_by: "codex", reason: "x", execution_authority: cosAuthority }, root), /requested_by/);
  await assert.rejects(requestRoleWake({ role: "coherence-manager", requested_by: "chief-of-staff", reason: "x", execution_authority: tonyAuthority }, root), /server-verified/);
});

test("later worker recovers a stale fenced seat and different roles claim concurrently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "role-seat-"));
  await requestRoleWake({ role: "coherence-manager", requested_by: "chief-of-staff", reason: "cm", execution_authority: cosAuthority }, root);
  const cm = await claimRoleWake({ worker_id: "mac:old", host: "mac" }, root);
  await requestRoleWake({ role: "estate-operations-manager", requested_by: "chief-of-staff", reason: "eom", execution_authority: cosAuthority }, root);
  const eom = await claimRoleWake({ worker_id: "mac:old", host: "mac" }, root);
  assert.equal(eom.seat.role, "estate-operations-manager");
  assert.equal((await requestRoleWake({ role: "coherence-manager", requested_by: "chief-of-staff", reason: "retry", execution_authority: cosAuthority }, root)).disposition, "occupied_noop");
  const recovered = await recoverStaleRoleSeats({ worker_id: "mac:new", host: "mac", stale_after_seconds: 60, now_ms: Date.now() + 61_000 }, root);
  assert.equal(recovered.length, 2);
  const retry = await requestRoleWake({ role: "coherence-manager", requested_by: "chief-of-staff", reason: "retry", execution_authority: cosAuthority }, root);
  assert.equal(retry.disposition, "queued");
  const reclaimed = await claimRoleWake({ worker_id: "mac:new", host: "mac" }, root);
  assert.equal(reclaimed.seat.generation, cm.seat.generation + 1);
});
