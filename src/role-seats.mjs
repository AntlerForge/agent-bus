import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { readJsonFile, writeJsonFileAtomic } from "./io.mjs";
import { ensureBusLayout } from "./paths.mjs";
import { sendMessage } from "./mailbox.mjs";

export const WAKEABLE_ROLES = ["coherence-manager", "estate-operations-manager", "estate-architect"];
const WAKE_CALLERS = new Set(["tony", "chief-of-staff", "estate-operations-manager"]);
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
function stateDefault() { return { schema_version: 2, seats: {}, wake_requests: [], occupant_notes: [], signals: [], events: [], worker: null, attention: null }; }
function digest(value) { return createHash("sha256").update(String(value)).digest("hex"); }

export async function readRoleSeats(root) {
  const paths = await ensureBusLayout(root);
  const state = await readJsonFile(paths.roleSeatsFile, stateDefault());
  state.schema_version = 2;
  state.seats ||= {};
  state.wake_requests ||= [];
  state.occupant_notes ||= [];
  state.signals ||= [];
  state.events ||= [];
  return state;
}

export async function requestRoleWake({ role, requested_by, reason, source_ref, how_woken = "on-demand", triggered_by = null, signal_key = null, episode_keys = [] }, root) {
  assertRole(role);
  if (!WAKE_CALLERS.has(requested_by)) throw new Error("requested_by must be tony, chief-of-staff, or estate-operations-manager");
  if (!String(reason || "").trim()) throw new Error("reason is required");
  const result = await serial(async () => {
    const paths = await ensureBusLayout(root);
    const state = await readRoleSeats(root);
    state.occupant_notes ||= [];
    state.signals ||= [];
    const occupied = state.seats[role];
    if (occupied?.status === "occupied") {
      const existingNote = signal_key && state.occupant_notes.find((item) => item.signal_key === signal_key);
      if (existingNote) return { disposition: "occupied_noop", seat: occupied, note: "Signal already delivered to the occupied seat.", event: state.events.find((item) => item.event_id === existingNote.event_id) };
      const event = { event_id: id("seat_event"), type: "wake_noop_occupied", role, requested_by, triggered_by, occupant: occupied.who, reason: String(reason), source_ref: source_ref || null, created_at: nowIso() };
      state.events.push(event);
      const note = { note_id: id("seat_note"), event_id: event.event_id, role, requested_by, signal_key, episode_keys, reason: String(reason), source_ref: source_ref || null, status: "pending", attempts: 0, created_at: event.created_at };
      state.occupant_notes.push(note);
      await writeJsonFileAtomic(paths.roleSeatsFile, state);
      return { disposition: "occupied_noop", seat: occupied, note: `Seat is occupied by ${occupied.who}; no second seating was created.`, event };
    }
    const existing = state.wake_requests.find((item) => item.role === role && item.status === "pending");
    if (existing) {
      existing.signal_keys = [...new Set([...(existing.signal_keys || []), ...(signal_key ? [signal_key] : [])])];
      existing.episode_keys = [...new Set([...(existing.episode_keys || []), ...episode_keys])];
      if (!existing.reasons?.includes(String(reason))) existing.reasons = [...(existing.reasons || [existing.reason]), String(reason)];
      await writeJsonFileAtomic(paths.roleSeatsFile, state);
      return { disposition: "already_pending", request: existing };
    }
    const request = { request_id: id("wake"), role, requested_by, triggered_by, signal_keys: signal_key ? [signal_key] : [], episode_keys, reason: String(reason), reasons: [String(reason)], source_ref: source_ref || null, how_woken, status: "pending", requested_at: nowIso() };
    state.wake_requests.push(request);
    state.events.push({ event_id: id("seat_event"), type: "wake_requested", role, request_id: request.request_id, requested_by, created_at: request.requested_at });
    await writeJsonFileAtomic(paths.roleSeatsFile, state);
    return { disposition: "queued", request };
  });
  if (result.disposition === "occupied_noop") await deliverRoleSeatNotes({}, root);
  return result;
}

export async function claimRoleWake({ worker_id, worker_identity, worker_pid, host = os.hostname() }, root) {
  if (!worker_id) throw new Error("worker_id is required");
  if (!worker_identity) throw new Error("worker_identity is required");
  if (!Number.isInteger(Number(worker_pid)) || Number(worker_pid) <= 0) throw new Error("worker_pid is required");
  return serial(async () => {
    const paths = await ensureBusLayout(root);
    const state = await readRoleSeats(root);
    const request = state.wake_requests.find((item) => item.status === "pending" && state.seats[item.role]?.status !== "occupied");
    if (!request) return null;
    const at = nowIso();
    request.status = "claimed"; request.claimed_at = at; request.worker_id = worker_id;
    const seat = { seat_id: id("seat"), role: request.role, who: request.role, since: at, where: host, how_woken: request.how_woken, wake_request_id: request.request_id, signal_keys: request.signal_keys || [], episode_keys: request.episode_keys || [], worker_id, worker_identity, worker_pid: Number(worker_pid), heartbeat_at: at, generation: Number(state.seats[request.role]?.generation || 0) + 1, status: "occupied" };
    state.seats[request.role] = seat;
    state.events.push({ event_id: id("seat_event"), type: "seat_occupied", role: request.role, seat_id: seat.seat_id, who: seat.who, created_at: at });
    await writeJsonFileAtomic(paths.roleSeatsFile, state);
    return { request, seat };
  });
}

export async function attachRoleSeatSession({ role, seat_id, generation, worker_id, session_pid, session_token }, root) {
  assertRole(role);
  if (!Number.isInteger(Number(session_pid)) || Number(session_pid) <= 0 || !session_token) throw new Error("session_pid and session_token are required");
  return serial(async () => {
    const paths = await ensureBusLayout(root);
    const state = await readRoleSeats(root);
    const seat = state.seats[role];
    if (!seat || seat.status !== "occupied" || seat.seat_id !== seat_id || seat.generation !== generation || seat.worker_id !== worker_id) throw new Error("active seat fence does not match");
    seat.session_pid = Number(session_pid);
    seat.session_token_sha256 = digest(session_token);
    seat.session_attached_at = nowIso();
    await writeJsonFileAtomic(paths.roleSeatsFile, state);
    return seat;
  });
}

export async function heartbeatRoleSeat({ role, seat_id, generation, worker_id }, root) {
  assertRole(role);
  return serial(async () => {
    const paths = await ensureBusLayout(root);
    const state = await readRoleSeats(root);
    const seat = state.seats[role];
    if (!seat || seat.status !== "occupied" || seat.seat_id !== seat_id || seat.generation !== generation || seat.worker_id !== worker_id) throw new Error("active seat fence does not match");
    seat.heartbeat_at = nowIso();
    await writeJsonFileAtomic(paths.roleSeatsFile, state);
    return seat;
  });
}

export async function recoverStaleRoleSeats({ worker_id, host = os.hostname(), stale_after_seconds = 180, now_ms = Date.now(), recovery_proofs = [] }, root) {
  if (!worker_id) throw new Error("worker_id is required");
  return serial(async () => {
    const paths = await ensureBusLayout(root);
    const state = await readRoleSeats(root);
    const recovered = [];
    for (const proof of recovery_proofs) {
      const seat = state.seats[proof.role];
      if (!seat || seat.seat_id !== proof.seat_id || seat.generation !== proof.generation) continue;
      const heartbeatMs = new Date(seat.heartbeat_at || seat.since).getTime();
      const sessionProvedDead = !seat.session_pid || (proof.session_pid === seat.session_pid && proof.session_token_sha256 === seat.session_token_sha256 && proof.session_identity_verified === true && proof.session_dead === true);
      if (seat.status !== "occupied" || seat.where !== host || seat.worker_id === worker_id || proof.worker_pid !== seat.worker_pid || proof.worker_dead !== true || !sessionProvedDead || now_ms - heartbeatMs < stale_after_seconds * 1000) continue;
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

export async function unseatRole({ role, seat_id, generation, worker_id, outcome = "completed", note = null }, root) {
  assertRole(role);
  return serial(async () => {
    const paths = await ensureBusLayout(root);
    const state = await readRoleSeats(root);
    const seat = state.seats[role];
    if (!seat || seat.status !== "occupied" || seat.seat_id !== seat_id || seat.generation !== generation || seat.worker_id !== worker_id) throw new Error("active seat fence does not match");
    const at = nowIso();
    seat.status = "unseated"; seat.unseated_at = at; seat.outcome = outcome; seat.note = note;
    const request = state.wake_requests.find((item) => item.request_id === seat.wake_request_id);
    if (request) { request.status = outcome === "completed" ? "completed" : "failed"; request.completed_at = at; }
    state.events.push({ event_id: id("seat_event"), type: "seat_unseated", role, seat_id, outcome, created_at: at });
    const attentionNotes = role === "estate-operations-manager"
      ? state.occupant_notes.filter((item) => item.role === role && item.signal_key && ["pending", "delivered"].includes(item.status) && new Date(item.created_at) >= new Date(seat.since))
      : [];
    const passHandled = state.attention?.last_completed_seat_id === seat_id;
    const unhandledSignalKeys = [...new Set([...(passHandled ? [] : seat.signal_keys || []), ...attentionNotes.map((item) => item.signal_key)])];
    if (role === "estate-operations-manager" && unhandledSignalKeys.length && !state.wake_requests.some((item) => item.role === role && item.status === "pending")) {
      const followup = { request_id: id("wake"), role, requested_by: "estate-operations-manager", triggered_by: "estate-operations-monitor", signal_keys: unhandledSignalKeys, episode_keys: [...new Set([...(seat.episode_keys || []), ...attentionNotes.flatMap((item) => item.episode_keys || [])])], reason: "Follow up monitor findings not explicitly handled before the prior EOM seat ended.", reasons: ["Follow up monitor findings not explicitly handled before the prior EOM seat ended."], source_ref: "agent-bus:role-attention-monitor", how_woken: "stuck-work-signal", status: "pending", requested_at: at };
      state.wake_requests.push(followup);
      state.events.push({ event_id: id("seat_event"), type: "wake_followup_requested", role, request_id: followup.request_id, created_at: at });
    }
    await writeJsonFileAtomic(paths.roleSeatsFile, state);
    return seat;
  });
}

export async function completeRoleAttentionPass({ seat_id, generation }, root) {
  return serial(async () => {
    const paths = await ensureBusLayout(root);
    const state = await readRoleSeats(root);
    const seat = state.seats["estate-operations-manager"];
    if (!seat || seat.status !== "occupied" || seat.seat_id !== seat_id || seat.generation !== generation) throw new Error("active EOM seat fence does not match");
    const at = nowIso();
    const handledKeys = new Set(seat.signal_keys || []);
    for (const note of state.occupant_notes) {
      if (note.role === seat.role && note.signal_key && new Date(note.created_at) >= new Date(seat.since)) {
        note.status = "handled"; note.handled_at = at; note.handled_by_seat_id = seat_id; handledKeys.add(note.signal_key);
      }
    }
    state.attention = { last_completed_at: at, last_completed_seat_id: seat_id, handled_signal_keys: [...handledKeys] };
    state.events.push({ event_id: id("seat_event"), type: "attention_pass_completed", role: seat.role, seat_id, generation, handled_signal_keys: [...handledKeys], created_at: at });
    await writeJsonFileAtomic(paths.roleSeatsFile, state);
    return state.attention;
  });
}

export async function deliverRoleSeatNotes({ limit = 20 } = {}, root) {
  const delivered = [];
  const state = await readRoleSeats(root);
  for (const note of (state.occupant_notes || []).filter((item) => item.status === "pending").slice(0, limit)) {
    let result;
    let errorMessage = null;
    try {
      result = await sendMessage({
        from: "role-wake-system", to: note.role, subject: "Wake request received while your seat is occupied",
        body: `A wake requested by ${note.requested_by} was suppressed because the role seat is occupied. Reason: ${note.reason}${note.source_ref ? `\nSource: ${note.source_ref}` : ""}`,
        intent: "inform", requires_response: false, idempotency_key: `role-seat-note:${note.note_id}`,
      }, root);
    } catch (error) { errorMessage = error.message; }
    await serial(async () => {
      const paths = await ensureBusLayout(root);
      const current = await readRoleSeats(root);
      const stored = (current.occupant_notes || []).find((item) => item.note_id === note.note_id);
      if (!stored || stored.status !== "pending") return;
      stored.attempts = Number(stored.attempts || 0) + 1;
      stored.last_attempt_at = nowIso();
      if (result) { stored.status = "delivered"; stored.message_id = result.message_id; stored.delivered_at = stored.last_attempt_at; delivered.push(stored); }
      else stored.last_error = errorMessage;
      await writeJsonFileAtomic(paths.roleSeatsFile, current);
    });
  }
  return { delivered: delivered.length };
}

export async function requestRoleAttentionSignal({ signal_type, signal_key, episode_keys = [], reason, source_ref, detected_at = nowIso() }, root) {
  if (!['stalled_work', 'patrol_due'].includes(signal_type)) throw new Error("signal_type must be stalled_work or patrol_due");
  if (!String(reason || "").trim()) throw new Error("reason is required");
  if (!String(signal_key || "").trim()) throw new Error("signal_key is required");
  const state = await readRoleSeats(root);
  const prior = (state.signals || []).findLast((item) => item.signal_key === signal_key);
  if (prior) return { disposition: prior.disposition, signal: prior, idempotent_replay: true };
  const result = await requestRoleWake({
    role: "estate-operations-manager", requested_by: "estate-operations-manager", triggered_by: "estate-operations-monitor",
    reason, source_ref, signal_key, episode_keys, how_woken: signal_type === "patrol_due" ? "routine-patrol" : "stuck-work-signal",
  }, root);
  await serial(async () => {
    const paths = await ensureBusLayout(root);
    const state = await readRoleSeats(root);
    state.signals ||= [];
    state.signals.push({ signal_id: id("role_signal"), signal_type, signal_key, episode_keys, reason: String(reason), source_ref: source_ref || null, detected_at, disposition: result.disposition, created_at: nowIso() });
    await writeJsonFileAtomic(paths.roleSeatsFile, state);
  });
  return result;
}

export async function heartbeatRoleWakeWorker({ worker_id, worker_pid, host = os.hostname() }, root) {
  if (!worker_id || !Number.isInteger(Number(worker_pid))) throw new Error("worker_id and worker_pid are required");
  return serial(async () => {
    const paths = await ensureBusLayout(root);
    const state = await readRoleSeats(root);
    state.worker = { worker_id, worker_pid: Number(worker_pid), host, last_seen_at: nowIso() };
    await writeJsonFileAtomic(paths.roleSeatsFile, state);
    return state.worker;
  });
}
