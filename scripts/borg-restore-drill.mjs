#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";
import { writeJsonFileAtomic } from "../src/io.mjs";

const execFile = promisify(execFileCb);
const archive = process.env.RESTORE_DRILL_ARCHIVE || "antler-a6-2026-07-19T200436Z";
const repository = process.env.BORG_REPO || "/mnt/backup/borg/a6-primary";
const stateBase = process.env.RESTORE_DRILL_BASE || "/srv/projects/Personal/agent-bus/runtime/restore-drills";
const assets = [
  "/srv/kv/vault/dashboard/doctor.json",
  "/srv/projects/Personal/agent-bus/app/scripts/decision-queue.mjs",
  "/srv/projects/Personal/agent-bus/app/config/decision-queue-sla.v1.yaml",
  "/etc/samba/smb.conf",
  "/share/Knowledge-Vault/tasks/day-board.md",
];

const hash = async (file) => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
const restorePath = (root, absolute) => path.join(root, absolute.slice(1));
const startedAt = new Date();
await fs.mkdir(stateBase, { recursive: true, mode: 0o700 });
const restoreRoot = await fs.mkdtemp(path.join(stateBase, "w3.2-20260719-"));
if (!restoreRoot.startsWith(`${stateBase}/w3.2-20260719-`)) throw new Error("Restore root escaped the declared isolation base");

const productionBefore = Object.fromEntries(await Promise.all(assets.map(async (file) => [file, await hash(file)])));
const info = JSON.parse((await execFile("sudo", ["borg", "info", "--json", `${repository}::${archive}`], { maxBuffer: 16 * 1024 * 1024 })).stdout);
const archiveTime = new Date(info.archives[0].start);
await execFile("sudo", ["borg", "extract", "--list", `${repository}::${archive}`, ...assets.map((file) => file.slice(1))], {
  cwd: restoreRoot,
  maxBuffer: 32 * 1024 * 1024,
});

const restoredHashes = Object.fromEntries(await Promise.all(assets.map(async (file) => [file, await hash(restorePath(restoreRoot, file))])));
const hashMatches = Object.fromEntries(assets.map((file) => [file, productionBefore[file] === restoredHashes[file]]));
JSON.parse(await fs.readFile(restorePath(restoreRoot, assets[0]), "utf8"));
YAML.parse(await fs.readFile(restorePath(restoreRoot, assets[2]), "utf8"));
await execFile(process.execPath, ["--check", restorePath(restoreRoot, assets[1])]);

const restoredDoctor = await fs.readFile(restorePath(restoreRoot, assets[0]));
const server = http.createServer((request, response) => {
  if (request.url !== "/doctor.json") { response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": "application/json" }); response.end(restoredDoctor);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
const served = await (await fetch(`http://127.0.0.1:${address.port}/doctor.json`)).json();
await new Promise((resolve) => server.close(resolve));
if (!served || !Array.isArray(served.checks)) throw new Error("Restored read model did not serve a valid doctor payload");

const productionAfter = Object.fromEntries(await Promise.all(assets.map(async (file) => [file, await hash(file)])));
const productionUntouched = assets.every((file) => productionBefore[file] === productionAfter[file]);
const endedAt = new Date();
const result = {
  schema_version: 1,
  drill_id: "w3.2-20260719",
  declared_manifest: "docs/w3.2-restore-drill-manifest-20260719.md",
  repository,
  archive,
  archive_time: archiveTime.toISOString(),
  started_at: startedAt.toISOString(),
  ended_at: endedAt.toISOString(),
  elapsed_rto_seconds: (endedAt - startedAt) / 1000,
  observed_rpo_seconds: (startedAt - archiveTime) / 1000,
  restore_root: restoreRoot,
  isolation_prefix_ok: true,
  production_untouched: productionUntouched,
  hash_matches: hashMatches,
  functional_smoke: { json_parse: true, yaml_parse: true, executable_syntax: true, loopback_serve_and_fetch: true },
  share_coverage: { asset: assets[4], restored: true, hash_match: hashMatches[assets[4]] },
};
if (!productionUntouched || !Object.values(hashMatches).every(Boolean)) throw new Error(`Restore verification failed: ${JSON.stringify(result)}`);
await writeJsonFileAtomic(path.join(stateBase, "w3.2-20260719-result.json"), result, { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
