import { readFile, rename, writeFile } from "node:fs/promises";
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
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}
