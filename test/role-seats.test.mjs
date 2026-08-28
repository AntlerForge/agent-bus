import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attachRoleSeatSession, claimRoleWake, readRoleSeats, recoverStaleRoleSeats, requestRoleWake, unseatRole } from "../src/role-seats.mjs";
import { readInbox } from "../src/mailbox.mjs";

test("role wake records occupancy and occupied wake is a safe no-op", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "role-seat-"));
  const queued = await requestRoleWake({ role: "coherence-manager", requested_by: "chief-of-staff", reason: "review queue" }, root);
  assert.equal(queued.disposition, "queued");
  const claimed = await claimRoleWake({ worker_id: "worker", worker_identity: "mac-role-wake-worker", worker_pid: 101, host: "mac" }, root);
  assert.equal(claimed.seat.who, "coherence-manager");
  assert.equal(claimed.seat.where, "mac");
  const noop = await requestRoleWake({ role: "coherence-manager", requested_by: "tony", reason: "second" }, root);
  assert.equal(noop.disposition, "occupied_noop");
  assert.match((await readInbox({ agent: "coherence-manager" }, root))[0].body, /suppressed/);
  await unseatRole({ role: "coherence-manager", seat_id: claimed.seat.seat_id, generation: claimed.seat.generation, worker_id: "worker" }, root);
  assert.equal((await readRoleSeats(root)).seats["coherence-manager"].status, "unseated");
});

test("role wake rejects provider identities and unsanctioned callers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "role-seat-"));
  await assert.rejects(requestRoleWake({ role: "coherence-manager-codex", requested_by: "chief-of-staff", reason: "x" }, root), /role must be/);
  await assert.rejects(requestRoleWake({ role: "coherence-manager", requested_by: "codex", reason: "x" }, root), /requested_by/);
  assert.equal((await requestRoleWake({ role: "estate-architect", requested_by: "estate-operations-manager", reason: "operability review" }, root)).disposition, "queued");
});

test("later worker recovers a stale fenced seat and different roles claim concurrently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "role-seat-"));
  await requestRoleWake({ role: "coherence-manager", requested_by: "chief-of-staff", reason: "cm" }, root);
  const cm = await claimRoleWake({ worker_id: "mac:old", worker_identity: "mac-role-wake-worker", worker_pid: 101, host: "mac" }, root);
  await attachRoleSeatSession({ role: cm.seat.role, seat_id: cm.seat.seat_id, generation: cm.seat.generation, worker_id: "mac:old", session_pid: 201, session_token: "cm-token" }, root);
  await requestRoleWake({ role: "estate-operations-manager", requested_by: "chief-of-staff", reason: "eom" }, root);
  const eom = await claimRoleWake({ worker_id: "mac:old", worker_identity: "mac-role-wake-worker", worker_pid: 101, host: "mac" }, root);
  assert.equal(eom.seat.role, "estate-operations-manager");
  assert.equal((await requestRoleWake({ role: "coherence-manager", requested_by: "chief-of-staff", reason: "retry" }, root)).disposition, "occupied_noop");
  const now = Date.now() + 61_000;
  const recovered = await recoverStaleRoleSeats({ worker_id: "mac:new", host: "mac", stale_after_seconds: 60, now_ms: now, recovery_proofs: [
    { role: cm.seat.role, seat_id: cm.seat.seat_id, generation: cm.seat.generation, worker_pid: 101, worker_dead: true, session_pid: 201, session_token_sha256: (await readRoleSeats(root)).seats[cm.seat.role].session_token_sha256, session_identity_verified: true, session_dead: true },
    { role: eom.seat.role, seat_id: eom.seat.seat_id, generation: eom.seat.generation, worker_pid: 101, worker_dead: true, session_dead: true },
  ] }, root);
  assert.equal(recovered.length, 2);
  const retry = await requestRoleWake({ role: "coherence-manager", requested_by: "chief-of-staff", reason: "retry" }, root);
  assert.equal(retry.disposition, "queued");
  const reclaimed = await claimRoleWake({ worker_id: "mac:new", worker_identity: "mac-role-wake-worker", worker_pid: 102, host: "mac" }, root);
  assert.equal(reclaimed.seat.generation, cm.seat.generation + 1);
});

test("stale recovery refuses an unproved live session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "role-seat-"));
  await requestRoleWake({ role: "coherence-manager", requested_by: "chief-of-staff", reason: "cm" }, root);
  const cm = await claimRoleWake({ worker_id: "old", worker_identity: "mac-role-wake-worker", worker_pid: 101, host: "mac" }, root);
  await attachRoleSeatSession({ role: cm.seat.role, seat_id: cm.seat.seat_id, generation: cm.seat.generation, worker_id: "old", session_pid: 201, session_token: "token" }, root);
  const recovered = await recoverStaleRoleSeats({ worker_id: "new", host: "mac", stale_after_seconds: 1, now_ms: Date.now() + 2_000, recovery_proofs: [{ role: cm.seat.role, seat_id: cm.seat.seat_id, generation: cm.seat.generation, worker_pid: 101, worker_dead: true, session_pid: 201, session_dead: true, session_identity_verified: false }] }, root);
  assert.equal(recovered.length, 0);
  assert.equal((await readRoleSeats(root)).seats[cm.seat.role].status, "occupied");
});
