#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { writeFileAtomic, writeJsonFileAtomic } from "../src/io.mjs";
import YAML from "yaml";

const execFile = promisify(execFileCb);
const scanRoot = path.resolve(process.env.REPO_RISK_ROOT || path.join(os.homedir(), "Developer"));
const output = process.env.REPO_RISK_OUTPUT || path.join(os.homedir(), "Library/Application Support/Agent Bus/repo-risk/latest.json");
const now = new Date(process.env.REPO_RISK_NOW || Date.now());
const baselineFile = process.env.REPO_RISK_BASELINE || "config/repo-risk-baseline-20260718.yaml";
const baseline = YAML.parse(await fs.readFile(baselineFile, "utf8"));
const skill = "/Users/antonybarfoot/Documents/Admin/knowledge-vault/vault/skills-catalog/knowledge-vault/tools/github_sync.py";

async function findRepos(root) {
  const repos = [];
  async function walk(dir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((entry) => entry.isDirectory() && entry.name === ".git")) { repos.push(dir); return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || [".git", "node_modules", ".venv", "venv", "Library", "dist", "build"].includes(entry.name)) continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }
  await walk(root, 0);
  return repos.sort();
}

async function git(repo, args) {
  try { const result = await execFile("git", ["-C", repo, ...args], { maxBuffer: 16 * 1024 * 1024 }); return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() }; }
  catch (error) { return { ok: false, stdout: String(error.stdout || "").trim(), stderr: String(error.stderr || error.message).trim(), code: error.code }; }
}
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
async function signature(repo) {
  const [head, refs, status] = await Promise.all([
    git(repo, ["rev-parse", "HEAD"]),
    git(repo, ["for-each-ref", "--format=%(refname):%(objectname)"]),
    git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  return digest(JSON.stringify({ head: head.stdout, refs: refs.stdout.split("\n").sort(), status: status.stdout }));
}

async function dirtyAgeDays(repo) {
  const names = new Set();
  for (const args of [["diff", "--name-only"], ["diff", "--cached", "--name-only"], ["ls-files", "--others", "--exclude-standard"]]) {
    const result = await git(repo, args); if (result.ok) for (const name of result.stdout.split("\n").filter(Boolean)) names.add(name);
  }
  const times = [];
  for (const name of names) {
    try { times.push((await fs.stat(path.join(repo, name))).mtimeMs); } catch {}
  }
  return times.length ? Math.max(0, (now.getTime() - Math.min(...times)) / 864e5) : null;
}

function actionFor(finding) {
  const quoted = `'${finding.path.replaceAll("'", "'\\''")}'`;
  if (finding.corrupt) return `Inspect only: git -C ${quoted} fsck --full; choose recovery source before any mutation.`;
  if (finding.no_remote) return `Review status, create/choose a private remote, then explicitly checkpoint: python3 ${skill} --repo ${quoted} status`;
  if (finding.dirty) return `Approve WIP checkpoint if appropriate: python3 ${skill} --repo ${quoted} checkpoint --branch wip/risk-checkpoint-${now.toISOString().slice(0,10).replaceAll("-","")} --message 'WIP: risk checkpoint ${now.toISOString().slice(0,10)}'`;
  if (finding.ahead > 0) return `Review committed work, then explicitly sync: python3 ${skill} --repo ${quoted} sync`;
  return `Review repository state: python3 ${skill} --repo ${quoted} status`;
}

async function inspect(repo) {
  const before = await signature(repo);
  const [status, remotes, upstream, fsck] = await Promise.all([
    git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(repo, ["remote"]),
    git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    git(repo, ["fsck", "--connectivity-only", "--no-dangling"]),
  ]);
  let ahead = 0;
  if (upstream.ok) {
    const result = await git(repo, ["rev-list", "--count", `${upstream.stdout}..HEAD`]);
    if (result.ok) ahead = Number(result.stdout || 0);
  }
  const dirty = Boolean(status.stdout);
  const dirty_age_days = dirty ? await dirtyAgeDays(repo) : null;
  const no_remote = !remotes.stdout;
  const corrupt = !fsck.ok;
  const after = await signature(repo);
  const finding = {
    repo: path.basename(repo), path: repo, dirty, dirty_count: status.stdout ? status.stdout.split("\n").length : 0,
    dirty_age_days, dirty_over_7d: dirty && dirty_age_days !== null && dirty_age_days > 7,
    ahead, upstream: upstream.ok ? upstream.stdout : null, no_remote, corrupt,
    fsck_error: corrupt ? fsck.stderr.split("\n").slice(0, 3).join("; ") : null,
    git_signature_unchanged: before === after,
  };
  finding.risk_score = (corrupt ? 100 : 0) + (no_remote ? 80 : 0) + (finding.dirty_over_7d ? 70 : dirty ? 25 : 0) + (ahead > 0 ? 60 : 0);
  finding.prepared_action = actionFor(finding);
  return finding;
}

const startedAt = new Date();
const repos = await findRepos(scanRoot);
const inspected = [];
for (const repo of repos) inspected.push(await inspect(repo));
const findings = inspected.filter((repo) => repo.corrupt || repo.no_remote || repo.dirty_over_7d || repo.ahead > 0)
  .sort((a, b) => b.risk_score - a.risk_score || a.path.localeCompare(b.path));
const byName = Object.fromEntries(inspected.map((repo) => [repo.repo, repo]));
const baseline_reconciliation = {
  audit_date: baseline.audit_date,
  status: "accounted_for",
  checks: {
    agent_bus_dirty_resolved: (byName["agent-bus"]?.dirty_count || 0) === 0,
    knowledge_vault_dirty_count: byName["knowledge-vault"]?.dirty_count === baseline.dirty_counts["knowledge-vault"],
    energy_points_ahead: byName.EnergyPoints?.ahead === baseline.ahead_counts.EnergyPoints,
    known_no_remote_present: baseline.no_remote.every((name) => byName[name]?.no_remote === true),
    known_corrupt_present: baseline.corrupt.every((name) => byName[name]?.corrupt === true),
  },
  updates: {
    EnergyPoints: { corrupt: byName.EnergyPoints?.corrupt || false },
    additional_corrupt: findings.filter((repo) => repo.corrupt && !baseline.corrupt.includes(repo.repo)).map((repo) => repo.repo),
  },
};
baseline_reconciliation.status = Object.values(baseline_reconciliation.checks).every(Boolean) ? "accounted_for" : "mismatch";
const result = {
  schema_version: 1,
  sweep_id: `repo-risk-${now.toISOString().slice(0,10)}`,
  observed_at: now.toISOString(),
  started_at: startedAt.toISOString(),
  completed_at: new Date().toISOString(),
  root: scanRoot,
  propose_only: true,
  repositories_scanned: inspected.length,
  git_signatures_unchanged: inspected.every((repo) => repo.git_signature_unchanged),
  counts: {
    findings: findings.length,
    dirty_over_7d: findings.filter((repo) => repo.dirty_over_7d).length,
    ahead: findings.filter((repo) => repo.ahead > 0).length,
    no_remote: findings.filter((repo) => repo.no_remote).length,
    corrupt: findings.filter((repo) => repo.corrupt).length,
  },
  baseline_reconciliation,
  findings,
  inspected,
};
await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
await writeJsonFileAtomic(output, result, { mode: 0o600 });
const table = [
  "# Weekly repository risk sweep",
  "",
  `Observed: ${result.observed_at} · scanned ${result.repositories_scanned} · findings ${result.counts.findings} · propose-only`,
  "",
  "| Rank | Repository | Score | Dirty / age | Ahead | No remote | Corrupt | Prepared action |",
  "| ---: | --- | ---: | --- | ---: | --- | --- | --- |",
  ...findings.map((repo, index) => `| ${index + 1} | ${repo.repo} | ${repo.risk_score} | ${repo.dirty_count} / ${repo.dirty_age_days === null ? "n/a" : `${repo.dirty_age_days.toFixed(1)}d`} | ${repo.ahead} | ${repo.no_remote ? "yes" : "no"} | ${repo.corrupt ? "yes" : "no"} | ${repo.prepared_action.replaceAll("|", "\\|")} |`),
  "",
];
await writeFileAtomic(output.replace(/\.json$/, ".md"), `${table.join("\n")}\n`);
console.log(JSON.stringify(result));
