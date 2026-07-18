#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const ACTIVE_RUNS = new Set(["queued", "dispatched", "acknowledged", "running", "waiting_input"]);
const TERMINAL_WORK = new Set(["done", "canceled", "review"]);
const TERMINAL_THREADS = new Set(["completed", "failed", "canceled", "closed"]);

export function lintState({ items, threads, now = Date.now(), staleHours = 24 }) {
  const findings = [];
  const cutoff = now - staleHours * 60 * 60 * 1000;
  for (const item of items) {
    for (const run of item.runs || []) {
      const updated = Date.parse(run.updated_at || run.started_at || 0);
      if (TERMINAL_WORK.has(item.status) && ACTIVE_RUNS.has(run.status)) {
        findings.push({ code: "RUN_ACTIVE_UNDER_TERMINAL_WORK", work_item_id: item.work_item_id, run_id: run.run_id, work_status: item.status, run_status: run.status });
      } else if (ACTIVE_RUNS.has(run.status) && updated < cutoff) {
        findings.push({ code: "RUN_STALE_ACTIVE", work_item_id: item.work_item_id, run_id: run.run_id, run_status: run.status, updated_at: run.updated_at });
      }
      if (run.usage && run.usage.total_tokens === 0 && run.usage.input_tokens === 0 && run.usage.output_tokens === 0) {
        findings.push({ code: "USAGE_ZERO_AMBIGUOUS", work_item_id: item.work_item_id, run_id: run.run_id });
      }
    }
  }
  for (const thread of threads) {
    const updated = Date.parse(thread.updated || thread.created || 0);
    if (!TERMINAL_THREADS.has(thread.status) && updated < cutoff) {
      findings.push({ code: "THREAD_STALE_OPEN", thread_id: thread.thread_id, status: thread.status, updated: thread.updated, subject: thread.subject });
    }
  }
  findings.sort((a, b) => `${a.code}:${a.work_item_id || a.thread_id}`.localeCompare(`${b.code}:${b.work_item_id || b.thread_id}`));
  return findings;
}

async function main() {
  const base = String(process.env.AGENT_BUS_CONTROL_PLANE_URL || "http://127.0.0.1:18091/agent-bus").replace(/\/+$/, "");
  const staleHours = Number(process.env.AGENT_BUS_STATE_STALE_HOURS || 24);
  const [itemsResponse, threadsResponse] = await Promise.all([fetch(`${base}/api/v1/work-items`), fetch(`${base}/api/v1/threads`)]);
  if (!itemsResponse.ok || !threadsResponse.ok) throw new Error(`State reads failed: work=${itemsResponse.status}, threads=${threadsResponse.status}`);
  const findings = lintState({ items: await itemsResponse.json(), threads: await threadsResponse.json(), staleHours });
  process.stdout.write(`${JSON.stringify({ ok: findings.length === 0, stale_hours: staleHours, findings }, null, 2)}\n`);
  process.exitCode = findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
