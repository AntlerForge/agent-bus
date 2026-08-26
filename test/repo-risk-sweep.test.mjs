import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const git = (repo, args) => execFile("git", ["-C", repo, ...args]);

test("repo-risk sweep is propose-only and prepares, but never executes, checkpoint actions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "repo-risk-test-"));
  const repo = path.join(root, "unprotected-repo"); const output = path.join(root, "latest.json");
  try {
    await fs.mkdir(repo);
    await git(repo, ["init"]); await git(repo, ["config", "user.email", "test@example.invalid"]); await git(repo, ["config", "user.name", "Test"]);
    const file = path.join(repo, "work.txt"); await fs.writeFile(file, "baseline\n"); await git(repo, ["add", "work.txt"]); await git(repo, ["commit", "-m", "baseline"]);
    await fs.writeFile(file, "uncommitted\n");
    const old = new Date("2026-07-01T00:00:00Z"); await fs.utimes(file, old, old);
    const beforeHead = (await git(repo, ["rev-parse", "HEAD"])).stdout;
    const beforeStatus = (await git(repo, ["status", "--porcelain=v1"])).stdout;
    await execFile(process.execPath, ["scripts/repo-risk-sweep.mjs"], { env: { ...process.env, REPO_RISK_ROOT: root, REPO_RISK_OUTPUT: output, REPO_RISK_NOW: "2026-07-19T00:00:00Z" } });
    const report = JSON.parse(await fs.readFile(output, "utf8"));
    assert.equal(report.propose_only, true); assert.equal(report.git_signatures_unchanged, true);
    assert.equal(report.findings.length, 1); assert.equal(report.findings[0].dirty_over_7d, true); assert.equal(report.findings[0].no_remote, true);
    assert.match(report.findings[0].prepared_action, /github_sync\.py/);
    assert.equal((await git(repo, ["rev-parse", "HEAD"])).stdout, beforeHead);
    assert.equal((await git(repo, ["status", "--porcelain=v1"])).stdout, beforeStatus);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("existing Mac reporter owns the seven-day refresh; no new scheduler is introduced", async () => {
  const reporter = await fs.readFile("scripts/outcome-truth-mac-report.sh", "utf8");
  assert.match(reporter, /604800/);
  assert.match(reporter, /repo-risk-sweep\.mjs/);
  assert.doesNotMatch(reporter, /launchctl|crontab/);
});

test("Mac reporter retries bounded A6 uploads within one scheduled run", async () => {
  const reporter = await fs.readFile("scripts/outcome-truth-mac-report.sh", "utf8");
  assert.match(reporter, /for attempt in 1 2 3/);
  assert.match(reporter, /ConnectTimeout=8/);
  assert.match(reporter, /ConnectionAttempts=1/);
  assert.match(reporter, /Mac outcome snapshot upload failed after 3 attempts/);
});
