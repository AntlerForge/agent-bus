import { createHash } from "node:crypto";

const OPEN_STATUSES = new Set(["proposed", "ready", "in_progress", "blocked", "review"]);
const STOP_WORDS = new Set(["a", "an", "and", "for", "from", "in", "of", "on", "the", "to", "with"]);

export function normalizeIntent(...parts) {
  return parts.join(" ").toLowerCase()
    .replace(/(?:msg|thread|work|run|job|assignment|receipt)_[a-z0-9_-]+/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:t[^\s]+)?\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim().split(/\s+/).filter((token) => token.length > 1 && !STOP_WORDS.has(token)).join(" ");
}

export function intentSignature(title, objective) {
  const normalized = normalizeIntent(title, objective);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

function similarity(left, right) {
  const a = new Set(left.split(" ").filter(Boolean));
  const b = new Set(right.split(" ").filter(Boolean));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function findDuplicateIntent(candidate, items, threshold = 0.82) {
  const normalized = normalizeIntent(candidate.title, candidate.objective);
  const signature = intentSignature(candidate.title, candidate.objective);
  let best = null;
  for (const item of items) {
    if (!OPEN_STATUSES.has(item.status)) continue;
    const score = similarity(normalized, normalizeIntent(item.title, item.objective));
    if (score >= threshold && (!best || score > best.score)) {
      best = { work_item_id: item.work_item_id, title: item.title, score };
    }
  }
  return { signature, normalized, duplicate: best };
}
