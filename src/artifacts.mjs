import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path, { basename } from "node:path";
import { makeId, nowIso } from "./ids.mjs";
import { readJsonFile, writeBufferAtomic, writeJsonFileAtomic } from "./io.mjs";
import { assertInsideShared, ensureBusLayout } from "./paths.mjs";

const MAX_REMOTE_ARTIFACT_BYTES = 700 * 1024;

export async function readArtifactManifest(root) {
  const paths = await ensureBusLayout(root);
  return readJsonFile(paths.artifactManifest, { artifacts: [] });
}

export async function uploadSharedArtifact({ filename, content_base64 }, root) {
  if (!filename || !content_base64) {
    throw new Error("filename and content_base64 are required");
  }
  const content = Buffer.from(content_base64, "base64");
  if (!content.length) {
    throw new Error("Artifact content is empty");
  }
  if (content.length > MAX_REMOTE_ARTIFACT_BYTES) {
    throw new Error(`Artifact exceeds ${MAX_REMOTE_ARTIFACT_BYTES} bytes`);
  }

  const paths = await ensureBusLayout(root);
  const uploadDirectory = path.join(paths.shared, "uploads");
  await mkdir(uploadDirectory, { recursive: true });
  const safeFilename = basename(filename).replace(/[^A-Za-z0-9._-]/g, "_") || "artifact.bin";
  const uploadPath = path.join(uploadDirectory, `${makeId("upload")}-${safeFilename}`);
  await writeBufferAtomic(uploadPath, content);
  return {
    path: uploadPath,
    filename: safeFilename,
    size: content.length,
  };
}

export async function readArtifactContent(artifactId, root) {
  const manifest = await readArtifactManifest(root);
  const artifact = manifest.artifacts.find((candidate) => candidate.artifact_id === artifactId);
  if (!artifact) {
    const error = new Error(`Artifact not found: ${artifactId}`);
    error.statusCode = 404;
    throw error;
  }
  const artifactPath = assertInsideShared(artifact.path, root);
  const content = await readFile(artifactPath);
  return {
    ...artifact,
    size: content.length,
    content_base64: content.toString("base64"),
  };
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
