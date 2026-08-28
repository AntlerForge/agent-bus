import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_BUS_ROOT = path.join(os.homedir(), "AgentBus");

export function expandHome(inputPath) {
  if (!inputPath) {
    return inputPath;
  }
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export function getBusRoot() {
  return path.resolve(expandHome(process.env.AGENT_BUS_ROOT) || DEFAULT_BUS_ROOT);
}

export function getPaths(root = getBusRoot()) {
  const busRoot = path.resolve(root);
  return {
    root: busRoot,
    inbox: path.join(busRoot, "inbox"),
    claudeInbox: path.join(busRoot, "inbox", "claude"),
    codexInbox: path.join(busRoot, "inbox", "codex"),
    threads: path.join(busRoot, "threads"),
    shared: path.join(busRoot, "shared"),
    archive: path.join(busRoot, "archive"),
    agentsFile: path.join(busRoot, "_agents.json"),
    roleSeatsFile: path.join(busRoot, "_role-seats.json"),
    idempotencyFile: path.join(busRoot, "_idempotency.json"),
    artifactManifest: path.join(busRoot, "shared", "_artifacts.json"),
    ambRoot: path.join(busRoot, "amb"),
    ambInbox: path.join(busRoot, "amb", "inbox"),
    ambAgentsFile: path.join(busRoot, "amb", "agents.json"),
    workLedger: path.join(busRoot, "work-ledger"),
    workItems: path.join(busRoot, "work-ledger", "items"),
  };
}

export async function ensureBusLayout(root = getBusRoot()) {
  const paths = getPaths(root);
  await Promise.all([
    mkdir(paths.claudeInbox, { recursive: true }),
    mkdir(paths.codexInbox, { recursive: true }),
    mkdir(paths.threads, { recursive: true }),
    mkdir(paths.shared, { recursive: true }),
    mkdir(paths.archive, { recursive: true }),
    mkdir(paths.ambInbox, { recursive: true }),
    mkdir(paths.workItems, { recursive: true }),
  ]);
  return paths;
}

export function assertInsideRoot(candidatePath, root = getBusRoot()) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(candidatePath);
  const relative = path.relative(resolvedRoot, resolvedPath);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolvedPath;
  }

  throw new Error(`Path is outside the Agent Bus root: ${candidatePath}`);
}

export function assertInsideShared(candidatePath, root = getBusRoot()) {
  const paths = getPaths(root);
  const resolvedShared = path.resolve(paths.shared);
  const resolvedPath = path.resolve(candidatePath);
  const relative = path.relative(resolvedShared, resolvedPath);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolvedPath;
  }

  throw new Error(`Shared artifact path must be inside ${resolvedShared}: ${candidatePath}`);
}
