import { readJsonFile, writeJsonFileAtomic } from "./io.mjs";

export async function readProviderSession(storePath, threadId) {
  const state = await readJsonFile(storePath, { schema_version: 1, threads: {} });
  return state.threads?.[threadId] || null;
}

export async function writeProviderSession(storePath, threadId, session) {
  const state = await readJsonFile(storePath, { schema_version: 1, threads: {} });
  state.schema_version = 1;
  state.threads ||= {};
  state.threads[threadId] = {
    ...(state.threads[threadId] || {}),
    ...session,
    updated_at: new Date().toISOString(),
  };
  await writeJsonFileAtomic(storePath, state);
  return state.threads[threadId];
}
