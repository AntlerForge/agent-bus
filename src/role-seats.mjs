import os from "node:os";
import { randomUUID } from "node:crypto";
import { readJsonFile, writeJsonFileAtomic } from "./io.mjs";
import { ensureBusLayout } from "./paths.mjs";
import { sendMessage } from "./mailbox.mjs";
import { trustedPolicyAllowsMessage } from "./trusted-policies.mjs";

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

export async function requestRoleWake({ role, requested_by, reason, source_ref, how_woken = "on-demand", execution_authority }, root) {
  assertRole(role);
  if (!WAKE_CALLERS.has(requested_by)) throw new Error("requested_by must be tony or chief-of-staff");
  const policyId = execution_authority?.type === "trusted_policy" ? execution_authority.policy_id : null;
  if (!policyId || !trustedPolicyAllowsMessage({ from: requested_by, to: role }, policyId)) {
    throw new Error("wake requires server-verified trusted-policy authority for the requester");
  }
  if (!String(reason || "").trim()) throw new Error("reason is required");
  return serial(async () => {
    const paths = await ensureBusLayout(root);
    const state = await readRoleSeats(root);
    const occupied = state.seats[role];
    if (occupied?.status === "occupied") {
      const event = { event_id: id("seat_event"), type: "wake_noop_occupied", role, requested_by, occupant: occupied.who, created_at: nowIso() };
      state.events.push(event);
      await writeJsonFileAtomic(paths.roleSeatsFile, state);
      await sendMessage({
        from: "role-wake-system", to: role, subject: "Wake request received while your seat is occupied",
        body: `A wake requested by ${requested_by} was suppressed because seat ${occupied.seat_id} is occupied. Reason: ${reason}`,
        intent: "inform", requires_response: false,
      }, root);
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
    const seat = { seat_id: id("seat"), role: request.role, who: request.role, since: at, where: host, how_woken: request.how_woken, wake_request_id: request.request_id, worker_id, heartbeat_at: at, generation: Number(state.seats[request.role]?.generation || 0) + 1, status: "occupied" };
    state.seats[request.role] = seat;
    state.events.push({ event_id: id("seat_event"), type: "seat_occupied", role: request.role, seat_id: seat.seat_id, who: seat.who, created_at: at });
    await writeJsonFileAtomic(paths.roleSeatsFile, state);
    return { request, seat };
  });
}

export async function heartbeatRoleSeat({ role, seat_id, worker_id }, root) {
  assertRole(role);
  return serial(async () => {
    const paths = await ensureBusLayout(root);
    const state = await readRoleSeats(root);
    const seat = state.seats[role];
    if (!seat || seat.status !== "occupied" || seat.seat_id !== seat_id || seat.worker_id !== worker_id) throw new Error("active seat fence does not match");
    seat.heartbeat_at = nowIso();
    await writeJsonFileAtomic(paths.roleSeatsFile, state);
    return seat;
  });
}

export async function recoverStaleRoleSeats({ worker_id, host = os.hostname(), stale_after_seconds = 180, now_ms = Date.now() }, root) {
  if (!worker_id) throw new Error("worker_id is required");
  return serial(async () => {
    const paths = await ensureBusLayout(root);
    const state = await readRoleSeats(root);
    const recovered = [];
    for (const seat of Object.values(state.seats)) {
      const heartbeatMs = new Date(seat.heartbeat_at || seat.since).getTime();
      if (seat.status !== "occupied" || seat.where !== host || seat.worker_id === worker_id || now_ms - heartbeatMs < stale_after_seconds * 1000) continue;
      const at = new Date(now_ms).toISOString();
      seat.status = "unseated"; seat.unseated_at = at; seat.outcome = "worker_lost"; seat.note = "Recovered by a later worker after the fenced heartbeat expired";
      const request = state.wake_requests.find((item) => item.request_id === seat.wake_request_id);
      if (request) { request.status = "failed"; request.completed_at = at; }
      state.events.push({ event_id: id("seat_event"), type: "stale_seat_recovered", role: seat.role, seat_id: seat.seat_id, recovered_by: worker_id, created_at: at });
      recovered.push(seat);
    }
    if (recovered.length) await writeJsonFileAtomic(paths.roleSeatsFile, state);
    return recovered;
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
