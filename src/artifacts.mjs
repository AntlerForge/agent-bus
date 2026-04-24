import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { makeId, nowIso } from "./ids.mjs";
import { readJsonFile, writeJsonFileAtomic } from "./io.mjs";
import { assertInsideShared, ensureBusLayout } from "./paths.mjs";

export async function readArtifactManifest(root) {
  const paths = await ensureBusLayout(root);
  return readJsonFile(paths.artifactManifest, { artifacts: [] });
}

export async function registerArtifacts({ artifact_paths = [], producer, message_id, thread_id }, root) {
  if (!artifact_paths?.length) {
    return [];
  }

  const paths = await ensureBusLayout(root);
  const manifest = await readArtifactManifest(root);
  const registered = [];

  for (const inputPath of artifact_paths) {
    const artifactPath = assertInsideShared(inputPath, root);
    const content = await readFile(artifactPath);
    const checksum = createHash("sha256").update(content).digest("hex");
    const existing = manifest.artifacts.find((artifact) => artifact.path === artifactPath && artifact.checksum === checksum);

    if (existing) {
      registered.push(existing);
      continue;
    }

    const artifact = {
      artifact_id: makeId("artifact"),
      path: artifactPath,
      filename: basename(artifactPath),
      kind: "file",
      producer,
      created: nowIso(),
      message_id,
      thread_id,
      checksum,
    };
    manifest.artifacts.push(artifact);
    registered.push(artifact);
  }

  await writeJsonFileAtomic(paths.artifactManifest, manifest);
  return registered;
}
