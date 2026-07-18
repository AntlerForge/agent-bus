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
    return { ...check, actual: actual ?? null, state: passes(check, actual) ? "pass" : "fail" };
  });
}

export function cardId(matrixId, checkId) {
  return `${matrixId}:${checkId}`;
}

export function applyEvaluation({ matrix, snapshot, previous = {}, now = new Date().toISOString(), shadowStartedAt = now }) {
  const cards = structuredClone(previous);
  const transitions = [];
  for (const result of evaluateMatrix(matrix, snapshot)) {
    const id = cardId(matrix.matrix_id, result.id);
    const prior = cards[id];
    if (result.state === "fail") {
      if (!prior || prior.status === "closed") {
        cards[id] = {
          card_id: id, check_id: result.id, owner: result.owner, severity: result.severity,
          status: "open", first_seen: now, last_seen: now, occurrences: 1,
          actual: result.actual, expected: result.expected, recovery_contract: result.recovery,
        };
        transitions.push({ type: "opened", card: cards[id], notify: result.severity === "hard" && now > shadowStartedAt });
      } else {
        prior.last_seen = now;
        prior.occurrences += 1;
        prior.actual = result.actual;
      }
    } else if (prior?.status === "open") {
      prior.status = "closed";
      prior.recovered_at = now;
      prior.last_seen = now;
      prior.actual = result.actual;
      transitions.push({ type: "recovered", card: prior, notify: true });
    }
  }
  return { cards, transitions, results: evaluateMatrix(matrix, snapshot) };
}

export async function loadCards(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

export async function saveCards(file, cards) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeJsonFileAtomic(file, cards);
}
