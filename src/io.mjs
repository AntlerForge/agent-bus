import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export async function readJsonFile(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function writeJsonFileAtomic(filePath, value) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeFileAtomic(filePath, content) {
  await writeAtomic(filePath, content, "utf8");
}

export async function writeBufferAtomic(filePath, content) {
  await writeAtomic(filePath, content);
}

async function writeAtomic(filePath, content, encoding) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const handle = await open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(content, encoding ? { encoding } : undefined);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      await unlink(tempPath).catch(() => {});
      if (error.code !== "ENOENT" || attempt === 3) throw error;
    }
  }
  throw lastError;
}
