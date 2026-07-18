import { spawn } from "node:child_process";

export function runCommand(command, args, { cwd, timeoutMs = 10 * 60 * 1000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs} ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}: ${(stderr || stdout).trim()}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
