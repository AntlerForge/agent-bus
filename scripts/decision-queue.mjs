#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";

const execFile = promisify(execFileCb);
const argv = new Set(process.argv.slice(2));
const now = new Date(process.env.DECISION_QUEUE_NOW || Date.now());
const root = process.env.AGENT_BUS_RUNTIME || "/srv/projects/Personal/agent-bus/runtime";
const vault = process.env.KV_VAULT_PATH || "/srv/kv/vault";
const outputDir = process.env.DECISION_QUEUE_DIR || `${root}/decision-queue`;
const config = YAML.parse(await fs.readFile(process.env.DECISION_QUEUE_CONFIG || "config/decision-queue-sla.v1.yaml", "utf8"));

const hoursSince = (value) => Math.max(0, (now - new Date(value)) / 36e5);
const frontmatter = (text) => {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try { return YAML.parse(match[1]); }
  catch {
    // Historical holding-pen packets include malformed quoted multiline fields.
    // Recover only the bounded scalar routing fields; do not reinterpret content.
    return Object.fromEntries(match[1].split("\n").map((line) => line.match(/^([a-z_]+):\s*["']?([^"'].*?)["']?\s*$/))
      .filter(Boolean).map((parts) => [parts[1], parts[2]]));
  }
};
const listFiles = async (dir, suffix = "") => (await fs.readdir(dir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map((entry) => path.join(dir, entry.name));
const item = (type, id, title, since, action, source) => {
  const age_hours = hoursSince(since);
  const sla_hours = config.slas_hours[type];
  return { id: `${type}:${id}`, type, source_id: id, title, since: new Date(since).toISOString(), age_hours, sla_hours,
    breached: age_hours > sla_hours, action, source, expiry_draft: age_hours > sla_hours * config.expiry_multiple
      ? `DRAFT — close or explicitly retain ${type}:${id}; apply only after Tony's approval through the source's validated writer.` : null };
};

async function collectCards() {
  const cards = JSON.parse(await fs.readFile(`${root}/outcome-truth/cards.json`, "utf8"));
  return Object.values(cards).filter((card) => card.status === "open").map((card) =>
    item("sentinel", card.check_id, card.check_id, card.first_seen, `Review the failure; close only by satisfying: ${card.recovery_contract}`, `${root}/outcome-truth/cards.json`));
}

async function collectWork() {
  const dir = `${root}/work-ledger/items`;
  const rows = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "work-item.md");
    const data = frontmatter(await fs.readFile(file, "utf8"));
    if (data.status === "proposed" || data.status === "review") rows.push(item("bus_work", data.work_item_id, data.title,
      data.updated_at || data.created_at, data.status === "proposed" ? `Accept or reject proposal ${data.work_item_id}` : `Approve or reject receipt ${data.receipt_ref || data.work_item_id}`, file));
  }
  const threadDir = `${root}/threads`;
  for (const file of await listFiles(threadDir, ".md")) {
    const data = frontmatter(await fs.readFile(file, "utf8"));
    if (["input_required", "awaiting_review"].includes(data.status) && hoursSince(data.updated) > config.slas_hours.bus_thread) rows.push(item("bus_thread", data.id,
      data.subject, data.updated, `Reply to or close thread ${data.id}`, file));
  }
  return rows;
}

async function collectHoldingPen() {
  const rows = [];
  for (const file of await listFiles(`${vault}/holding-pen`, ".md")) {
    const data = frontmatter(await fs.readFile(file, "utf8"));
    if (data.status !== "pending_review") continue;
    rows.push(item("holding_pen", data.item_id || path.basename(file, ".md"), data.title || path.basename(file), data.created || data.date || (await fs.stat(file)).birthtime,
      `File or discard ${path.basename(file)} using the funnel workflow`, file));
  }
  return rows;
}

async function collectFlags() {
  const file = `${vault}/tasks/agent-flags.md`;
  const text = await fs.readFile(file, "utf8");
  const block = text.match(/```yaml\n([\s\S]*?)```/)?.[1];
  const flags = YAML.parse(block || "flags: []").flags || [];
  return flags.filter((flag) => flag.status === "open").map((flag) => item("agent_flag", flag.id, flag.title, `${flag.date}T00:00:00Z`,
    `Resolve or dismiss flag ${flag.id} via the validated flag workflow`, file));
}

async function collectTasks() {
  const file = `${vault}/tasks/todo-list.md`;
  const lines = (await fs.readFile(file, "utf8")).split("\n");
  const rows = [];
  for (const line of lines) {
    if (!/^\| T\d+ \|/.test(line)) continue;
    const cols = line.split("|").slice(1, -1).map((value) => value.trim());
    const [id, title, status, , , due, , planned] = cols;
    if (status !== "open") continue;
    const date = due || planned;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || new Date(`${date}T23:59:59Z`) >= now) continue;
    rows.push(item("overdue_task", id, title, `${date}T23:59:59Z`, `Complete, reschedule, or close task ${id} via the validated task writer`, file));
  }
  return rows;
}

async function collectDayBoard() {
  const file = `${vault}/tasks/day-board.md`;
  const data = frontmatter(await fs.readFile(file, "utf8"));
  if (!data.last_updated) return [];
  const candidate = item("day_board", "canonical", "Refresh the canonical day board", `${data.last_updated}T00:00:00Z`,
    "Refresh or explicitly retain the day board through board.py", file);
  return candidate.breached ? [candidate] : [];
}

async function collectFunnel() {
  const file = `${vault}/_cache/funnel/pending-approvals.jsonl`;
  let text = "";
  try { text = await fs.readFile(file, "utf8"); } catch { return []; }
  return text.trim().split("\n").filter(Boolean).map(JSON.parse).filter((row) => row.status === "pending").map((row) => item("funnel_approval",
    row.audit_id, `${row.tool} approval for ${row.persona}`, row.timestamp, `Approve or reject funnel action ${row.audit_id}`, file));
}

const queue = (await Promise.all([collectCards(), collectWork(), collectHoldingPen(), collectFlags(), collectTasks(), collectDayBoard(), collectFunnel()]))
  .flat().sort((a, b) => b.age_hours - a.age_hours || a.id.localeCompare(b.id));
const percentile = (values, p) => values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : 0;
const ages = queue.map((row) => row.age_hours).sort((a, b) => a - b);
const by_type = Object.fromEntries([...new Set(queue.map((row) => row.type))].map((type) => [type, queue.filter((row) => row.type === type).length]));
const baseline = config.baseline_oracle;
const queueIds = new Set(queue.map((row) => row.source_id));
const baseline_reconciliation = {
  status: "accounted_for",
  evidence_ref: baseline.evidence_ref,
  note: "The oracle records the 2026-07-18 audit. Active counts may increase or decrease after semantic recovery and source processing; required identities and minimum/approximate populations are checked here.",
  checks: {
    historical_sentinel_cards_declared: baseline.sentinel_cards === 8,
    required_bus_items_present: baseline.bus_item_ids.every((id) => queueIds.has(id)),
    holding_pen_population_reconciled: Math.abs((by_type.holding_pen || 0) - baseline.holding_pen_approx) <= 2,
    required_flags_present: baseline.required_flag_ids.every((id) => queueIds.has(id)),
    overdue_population_at_least_audit: (by_type.overdue_task || 0) >= baseline.overdue_tasks,
    day_board_breach_present: (by_type.day_board || 0) === baseline.day_board_breach,
  },
};
baseline_reconciliation.status = Object.values(baseline_reconciliation.checks).every(Boolean) ? "accounted_for" : "mismatch";
const snapshot = { schema_version: 1, queue_id: config.queue_id, generated_at: now.toISOString(), read_only: true,
  metrics: { count: queue.length, breached: queue.filter((row) => row.breached).length, p50_age_hours: percentile(ages, .5), p90_age_hours: percentile(ages, .9), by_type },
  baseline_oracle: config.baseline_oracle, baseline_reconciliation, items: queue };

await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
const atomic = async (file, content) => { const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, content, { mode: 0o600 }); await fs.rename(tmp, file); };
await atomic(`${outputDir}/queue.json`, `${JSON.stringify(snapshot, null, 2)}\n`);
try { await fs.access(`${outputDir}/baseline.json`); } catch { await atomic(`${outputDir}/baseline.json`, `${JSON.stringify(snapshot, null, 2)}\n`); }

let previous = { breached_ids: [] };
try { previous = JSON.parse(await fs.readFile(`${outputDir}/state.json`, "utf8")); } catch {}
const breachedIds = queue.filter((row) => row.breached).map((row) => row.id);
const newBreaches = previous.initialized ? breachedIds.filter((id) => !previous.breached_ids.includes(id)) : [];
await atomic(`${outputDir}/state.json`, `${JSON.stringify({ initialized: true, evaluated_at: now.toISOString(), breached_ids: breachedIds }, null, 2)}\n`);
await atomic(`${outputDir}/last-evaluation.json`, `${JSON.stringify({ evaluated_at: now.toISOString(), new_breaches: newBreaches }, null, 2)}\n`);

const notify = async (klass, id, message) => {
  if (argv.has("--no-notify")) return;
  await execFile(process.execPath, ["scripts/ha-notify-tony.mjs", "--class", klass, "--id", id, "--message", message]);
};
if (newBreaches.length) await notify("ALERT", `decision-queue-breach-${now.toISOString().slice(0, 13)}`, `${newBreaches.length} waiting-on-Tony item(s) newly breached SLA. See ${outputDir}/queue.json`);

if (argv.has("--weekly") || now.getUTCDay() === 0) {
  const selected = queue.slice(0, config.weekly_limit);
  const lines = selected.map((row) => `- ${row.title} — ${Math.floor(row.age_hours / 24)}d — ${row.action}`);
  const pack = `# DECISION PACK — ${now.toISOString().slice(0, 10)}\n\n${lines.join("\n")}\n`;
  const packFile = `${outputDir}/decision-pack-${now.toISOString().slice(0, 10)}.md`;
  await atomic(packFile, pack);
  await notify("INFO", `decision-pack-${now.toISOString().slice(0, 10)}`, `${selected.length} decisions ready: ${packFile}`);
}
console.log(JSON.stringify(snapshot));
