#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => value.startsWith("--") ? [value.slice(2), all[index + 1]] : null).filter(Boolean));
const output = path.resolve(args.output || path.join(process.env.HOME, ".config", "agent-bus", "role-wake"));
const entries = [
  ["tony", "caller"], ["chief-of-staff", "caller"], ["estate-operations-manager", "caller"],
  ["mac-role-wake-worker", "worker"], ["estate-operations-monitor", "monitor"],
];
await mkdir(output, { recursive: true, mode: 0o700 });
const credentials = [];
for (const [identity, kind] of entries) {
  const token = randomBytes(32).toString("hex");
  const filename = path.join(output, `${identity}.env`);
  const handle = await open(filename, "wx", 0o600);
  await handle.writeFile(`AGENT_BUS_ROLE_WAKE_TOKEN=${token}\n`);
  await handle.close();
  credentials.push({ identity, kind, token_sha256: createHash("sha256").update(token).digest("hex") });
}
const controlPlane = path.join(output, "role-wake-credentials.json");
await writeFile(controlPlane, `${JSON.stringify({ schema_version: 1, credentials }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
process.stdout.write(`${JSON.stringify({ output, control_plane: controlPlane, identities: entries.map(([identity]) => identity) })}\n`);
