import os from "node:os";
import { randomUUID } from "node:crypto";
import { readJsonFile, writeJsonFileAtomic } from "./io.mjs";
import { ensureBusLayout } from "./paths.mjs";

export const WAKEABLE_ROLES = ["coherence-manager", "estate-operations-manager", "estate-architect"];
const WAKE_CALLERS = new Set(["tony", "chief-of-staff"]);
let queue = Promise.resolve();

function serial(operation) {
  const next = queue.then(operation, operation);
  queue = next.catch(() => {});
  return next;
}

function nowIso() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`; }
function assertRole(role) {
  if (!WAKEABLE_ROLES.includes(role)) throw new Error(`role must be one of: ${WAKEABLE_ROLES.join(", ")}`);
}
function stateDefault() { return { schema_version: 1, seats: {}, wake_requests: [], events: [] }; }

export async function readRoleSeats(root) {
  const paths = await ensureBusLayout(root);
  return readJsonFile(paths.roleSeatsFile, stateDefault());
}

export async function requestRoleWake({ role, requested_by, reason, source_ref, how_woken = "on-demand" }, root) {
  assertRole(role);
  if (!WAKE_CALLERS.has(requested_by)) throw new Error("requested_by must be tony or chief-of-staff");
  if (!String(reason || "").trim()) throw new Error("reason is required");
  return serial(async () => {
    const paths = await ensureBusLayout(root);
    const state = await readRoleSeats(root);
    const occupied = state.seats[role];
    if (occupied?.status === "occupied") {
      const event = { event_id: id("seat_event"), type: "wake_noop_occupied", role, requested_by, occupant: occupied.who, created_at: nowIso() };
      state.events.push(event);
      await writeJsonFileAtomic(paths.roleSeatsFile, state);
      return { disposition: "occupied_noop", seat: occupied, note: `Seat is occupied by ${occupied.who}; no second seating was created.`, event };
    }
    const existing = state.wake_requests.find((item) => item.role === role && item.status === "pending");
    if (existing) return { disposition: "already_pending", request: existing };
    const request = { request_id: id("wake"), role, requested_by, reason: String(reason), source_ref: source_ref || null, how_woken, status: "pending", requested_at: nowIso() };
    state.wake_requests.push(request);
    state.events.push({ event_id: id("seat_event"), type: "wake_requested", role, request_id: request.request_id, requested_by, created_at: request.requested_at });
    await writeJsonFileAtomic(paths.roleSeatsFile, state);
    return { disposition: "queued", request };
  });
}

export async function claimRoleWake({ worker_id, host = os.hostname() }, root) {
  if (!worker_id) throw new Error("worker_id is required");
  return serial(async () => {
    const paths = await ensureBusLayout(root);
    const state = await readRoleSeats(root);
    const request = state.wake_requests.find((item) => item.status === "pending" && state.seats[item.role]?.status !== "occupied");
    if (!request) return null;
    const at = nowIso();
    request.status = "claimed"; request.claimed_at = at; request.worker_id = worker_id;
    const seat = { seat_id: id("seat"), role: request.role, who: request.role, since: at, where: host, how_woken: request.how_woken, wake_request_id: request.request_id, status: "occupied" };
    state.seats[request.role] = seat;
    state.events.push({ event_id: id("seat_event"), type: "seat_occupied", role: request.role, seat_id: seat.seat_id, who: seat.who, created_at: at });
    await writeJsonFileAtomic(paths.roleSeatsFile, state);
    return { request, seat };
  });
}

export async function unseatRole({ role, seat_id, outcome = "completed", note = null }, root) {
  assertRole(role);
  return serial(async () => {
    const paths = await ensureBusLayout(root);
    const state = await readRoleSeats(root);
    const seat = state.seats[role];
    if (!seat || seat.status !== "occupied" || seat.seat_id !== seat_id) throw new Error("active seat does not match");
    const at = nowIso();
    seat.status = "unseated"; seat.unseated_at = at; seat.outcome = outcome; seat.note = note;
    const request = state.wake_requests.find((item) => item.request_id === seat.wake_request_id);
    if (request) { request.status = outcome === "completed" ? "completed" : "failed"; request.completed_at = at; }
    state.events.push({ event_id: id("seat_event"), type: "seat_unseated", role, seat_id, outcome, created_at: at });
    await writeJsonFileAtomic(paths.roleSeatsFile, state);
    return seat;
  });
}
