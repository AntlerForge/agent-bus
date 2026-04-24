import { randomBytes } from "node:crypto";

export function makeId(prefix, date = new Date()) {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "_")
    .replace("Z", "");
  const suffix = randomBytes(2).toString("hex");
  return `${prefix}_${stamp}_${suffix}`;
}

export function nowIso() {
  return new Date().toISOString();
}
