import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../io.mjs";

const DEFAULT_ROOT = "/srv/projects/Personal/agent-bus/runtime";
const DEFAULT_URL = "https://kv.antlerforge.com/#tasks";
const FILEBROWSER_URL = "http://antler-a6:8088/Projects/Personal/agent-bus/runtime/estate-status/estate-status.md";

async function json(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function files(dir, suffix) {
  try { return (await fs.readdir(dir)).filter((name) => name.endsWith(suffix)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

const human = (value) => String(value || "unknown").replace(/^.*?:/, "").replace(/[-_]+/g, " ");
const hours = (value) => value < 48 ? `${Math.round(value)}h` : `${Math.floor(value / 24)}d`;
const clean = (value) => String(value || "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

function alertMeaning(send, cards) {
  const match = String(send.id).match(/^outcome-[^:]+:(.+)-(opened|recovered)-\d{4}/);
  if (!match) return { event: human(send.id), state: send.class === "ALERT" ? "alert sent" : "information sent" };
  const card = Object.values(cards).find((row) => row.check_id === match[1]);
  return { event: human(match[1]), state: card?.status === "open" ? "currently open" : "recovered" };
}

export async function renderEstateStatus({ runtimeRoot = DEFAULT_ROOT, outputFile, generatedAt = new Date().toISOString(), statusUrl = DEFAULT_URL } = {}) {
  const cards = await json(`${runtimeRoot}/outcome-truth/cards.json`, {});
  const queue = await json(`${runtimeRoot}/decision-queue/queue.json`, { metrics: {}, items: [] });
  const sendNames = await files(`${runtimeRoot}/ha-notify/sends`, ".json");
  const sends = (await Promise.all(sendNames.map((name) => json(`${runtimeRoot}/ha-notify/sends/${name}`, null))))
    .filter(Boolean).filter((row) => row.class === "ALERT").sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at))).slice(0, 20);
  const packs = (await files(`${runtimeRoot}/decision-queue`, ".md")).filter((name) => name.startsWith("decision-pack-")).sort().reverse();
  const open = Object.values(cards).filter((card) => card.status === "open").sort((a, b) => String(a.first_seen).localeCompare(String(b.first_seen)));
  const base = FILEBROWSER_URL.replace(/\/estate-status\/estate-status\.md$/, "/decision-queue/");
  const packUrl = packs[0] ? new URL(packs[0], base).href : null;
  const breachUrl = new URL("breach-summary.md", base).href;
  const lines = [
    "# Estate Status", "", `Generated: ${generatedAt}`, "",
    "This is the durable fallback for estate alerts. The authenticated KV Dashboard Action Centre is primary; source systems remain authoritative.", "", `[Open the Dashboard Action Centre](${statusUrl})`, "",
    "## Open exceptions", "",
  ];
  if (!open.length) lines.push("No open semantic exception cards.", "");
  else for (const card of open) lines.push(`### ${human(card.check_id)}`, "", `- First observed: ${card.first_seen}`, `- Last observed: ${card.last_seen}`, `- Current value: ${clean(JSON.stringify(card.actual))}`, `- Recovery needed: ${clean(card.recovery_contract)}`, "");
  lines.push("## Waiting-on-Tony queue", "", `- Items: ${queue.metrics?.count ?? "unknown"}`, `- Breached SLA: ${queue.metrics?.breached ?? "unknown"}`, `- Median age: ${queue.metrics?.p50_age_hours == null ? "unknown" : hours(queue.metrics.p50_age_hours)}`, `- 90th-percentile age: ${queue.metrics?.p90_age_hours == null ? "unknown" : hours(queue.metrics.p90_age_hours)}`, `- [Latest breach summary](${breachUrl})`, packUrl ? `- [Latest decision pack](${packUrl})` : "- Latest decision pack: not generated", "", "## Recent alert history", "", "| Time | Alert | Recovery state |", "|---|---|---|");
  if (!sends.length) lines.push("| — | No alerts recorded | — |");
  else for (const send of sends) { const meaning = alertMeaning(send, cards); lines.push(`| ${clean(send.sent_at)} | ${clean(meaning.event)} | ${clean(meaning.state)} |`); }
  lines.push("", "## Bookmarks", "", `- [Dashboard Action Centre](${statusUrl})`, `- [FileBrowser fallback](${FILEBROWSER_URL})`, "");
  const target = outputFile || `${runtimeRoot}/estate-status/estate-status.md`;
  await writeFileAtomic(target, `${lines.join("\n")}\n`);
  return { output_file: target, status_url: statusUrl, open_cards: open.length, alerts: sends.length };
}

export async function renderBreachSummary({ snapshot, newBreaches, outputFile, generatedAt = new Date().toISOString(), statusUrl = DEFAULT_URL }) {
  const wanted = new Set(newBreaches || []);
  const items = (snapshot.items || []).filter((row) => wanted.has(row.id));
  const lines = ["# Decision Queue Breach Summary", "", `Generated: ${generatedAt}`, "", `[Back to Estate Status](${statusUrl})`, "", `${items.length} item(s) newly crossed their waiting-time agreement.`, ""];
  for (const row of items) lines.push(`## ${clean(row.title)}`, "", `- Waiting: ${hours(row.age_hours)}`, `- Agreement: ${hours(row.sla_hours)}`, `- Action: ${clean(row.action)}`, "");
  if (!items.length) lines.push("No new breaches in the latest evaluation.", "");
  await writeFileAtomic(outputFile, `${lines.join("\n")}\n`);
  return { output_file: outputFile, breaches: items.length };
}
