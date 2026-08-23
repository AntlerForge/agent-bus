import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function getWriteToken(env = process.env) {
  if (env.AGENT_BUS_WRITE_TOKEN) return env.AGENT_BUS_WRITE_TOKEN;
  const tokenFile = env.AGENT_BUS_WRITE_TOKEN_FILE
    || path.join(os.homedir(), ".config", "agent-bus", "write-token.env");
  try {
    const line = readFileSync(tokenFile, "utf8")
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith("AGENT_BUS_WRITE_TOKEN="));
    return line?.slice("AGENT_BUS_WRITE_TOKEN=".length).trim() || null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
