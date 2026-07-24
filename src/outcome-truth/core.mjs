import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { writeJsonFileAtomic } from "../io.mjs";

export async function loadMatrix(file) {
  const matrix = YAML.parse(await fs.readFile(file, "utf8"));
  if (matrix?.schema_version !== 1 || !Array.isArray(matrix.checks)) throw new Error("Unsupported outcome matrix");
  return matrix;
}

function get(source, key) {
  return key.split(".").reduce((value, part) => value?.[part], source);
}

function passes(check, actual) {
  if (actual === undefined || actual === null) return false;
  if (check.operator === "equals") return actual === check.expected;
  if (check.operator === "at_most") return Number(actual) <= Number(check.expected);
  throw new Error(`Unknown operator ${check.operator}`);
}

export function evaluateMatrix(matrix, snapshot) {
  return matrix.checks.map((check) => {
    const actual = get(snapshot, check.source);
    const probeFault = actual === undefined || actual === null
      || (check.operator === "at_most" && !Number.isFinite(Number(actual)));
    return { ...check, actual: actual ?? null, state: probeFault ? "probe_fault" : passes(check, actual) ? "pass" : "fail" };
  });
}

export function cardId(matrixId, checkId) {
  return `${matrixId}:${checkId}`;
}

export function probeCardId(matrixId, checkId) {
  return `${matrixId}:probe-fault:${checkId}`;
}

export function synthesisSemanticallyClean(row) {
  if (!row || !["run_completed", "run_warning"].includes(row.event)) return false;
  if (row.event === "run_completed") return true;
  const metadata = row.metadata || {};
  const intake = metadata.intake || {};
  const triage = intake.triage || {};
  const dashboard = metadata.dashboard || {};
  const maintenance = metadata.maintenance || {};
  return intake.required_adapter_status === "ok"
    && Number(triage.auto_errors || 0) === 0
    && ["ok", undefined].includes(dashboard.build)
    && ["ok", undefined].includes(dashboard.healthz)
    && Number(maintenance.doctor_hard_failures || 0) === 0;
}

export function scheduledFreshnessHealthy({
  statusOk,
  integrityOk,
  ageMinutes,
  now = new Date(),
  firstDueUtc,
  lastDueUtc,
  graceMinutes,
}) {
  if (!statusOk || !integrityOk || !Number.isFinite(Number(ageMinutes))) return false;
  if (Number(ageMinutes) <= Number(graceMinutes)) return true;
  const [firstHour, firstMinute] = firstDueUtc.split(":").map(Number);
  const [lastHour, lastMinute] = lastDueUtc.split(":").map(Number);
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  const evaluationStart = firstHour * 60 + firstMinute + Number(graceMinutes);
  const evaluationEnd = lastHour * 60 + lastMinute + Number(graceMinutes);
  return minuteOfDay < evaluationStart || minuteOfDay > evaluationEnd;
}

export function applyEvaluation({ matrix, snapshot, previous = {}, now = new Date().toISOString(), shadowStartedAt = now }) {
  const cards = structuredClone(previous);
  const transitions = [];
  const alertAfterMinutes = Number(matrix.alert_after_minutes || 0);
  const results = evaluateMatrix(matrix, snapshot);
  for (const result of results) {
    const id = cardId(matrix.matrix_id, result.id);
    const prior = cards[id];
    const probeId = probeCardId(matrix.matrix_id, result.id);
    const priorProbe = cards[probeId];
    if (result.state === "probe_fault") {
      if (!priorProbe || priorProbe.status === "closed") {
        const notify = now > shadowStartedAt;
        cards[probeId] = {
          card_id: probeId, card_class: "probe_fault", check_id: `probe-fault:${result.id}`,
          probe_check_id: result.id, probe_source: result.source, owner: result.owner,
          severity: "hard", status: "open", first_seen: now, last_seen: now,
          occurrences: 1, actual: null, expected: "observable typed value",
          recovery_contract: `probe ${result.source} returns a typed value and the contract is evaluated again`,
          notification_state: notify ? "sent" : "suppressed",
          ...(notify ? { notified_at: now } : {}),
        };
        transitions.push({ type: "probe_fault_opened", card: cards[probeId], notify });
      } else {
        priorProbe.last_seen = now;
        priorProbe.occurrences += 1;
      }
      continue;
    }
    if (priorProbe?.status === "open") {
      priorProbe.status = "closed";
      priorProbe.recovered_at = now;
      priorProbe.last_seen = now;
      priorProbe.actual = result.actual;
      const notified = priorProbe.notification_state === "sent";
      priorProbe.notification_state = notified ? "recovered" : "closed_without_notification";
      transitions.push({ type: "probe_fault_recovered", card: priorProbe, notify: notified });
    }
    if (result.state === "fail") {
      if (!prior || prior.status === "closed") {
        cards[id] = {
          card_id: id, check_id: result.id, owner: result.owner, severity: result.severity,
          status: "open", first_seen: now, last_seen: now, occurrences: 1,
          actual: result.actual, expected: result.expected, recovery_contract: result.recovery,
          notification_state: alertAfterMinutes > 0 ? "pending" : "sent",
        };
        const notify = result.severity === "hard" && now > shadowStartedAt && alertAfterMinutes === 0;
        if (notify) cards[id].notified_at = now;
        transitions.push({ type: "opened", card: cards[id], notify });
      } else {
        prior.last_seen = now;
        prior.occurrences += 1;
        prior.actual = result.actual;
        const openMinutes = (Date.parse(now) - Date.parse(prior.first_seen)) / 60000;
        if (prior.notification_state === "pending" && result.severity === "hard" && now > shadowStartedAt && openMinutes >= alertAfterMinutes) {
          prior.notification_state = "sent";
          prior.notified_at = now;
          transitions.push({ type: "escalated", card: prior, notify: true });
        }
      }
    } else if (prior?.status === "open") {
      prior.status = "closed";
      prior.recovered_at = now;
      prior.last_seen = now;
      prior.actual = result.actual;
      const notified = prior.notification_state === "sent" || prior.notification_state == null;
      prior.notification_state = notified ? "recovered" : "closed_without_notification";
      transitions.push({ type: "recovered", card: prior, notify: notified });
    }
  }
  return { cards, transitions, results };
}

export async function loadCards(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

export async function saveCards(file, cards) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeJsonFileAtomic(file, cards);
}
