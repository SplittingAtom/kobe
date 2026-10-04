import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

/**
 * The per-process runtime directories (threads/thread.ts): `<runtimeDir>/pi-XXXXXX/` with `agent/`
 * (Pi's `PI_CODING_AGENT_DIR`) and `model.json`. A sibling process of the same user can write into
 * them while a Pi runs (KOBE-41 review, MEDIUM 1): until Pi runs under its own uid, the agent
 * detects it (`unexpectedEntries`) and sweeps leftovers of earlier agents at start-up.
 */
export const RUNTIME_DIR_PREFIX = "pi-";
export const AGENT_SUBDIR = "agent";
export const MODEL_FILE_NAME = "model.json";
/**
 * What Pi 1.0.0 itself writes into its config dir under Kobe's launch flags (verified: a fresh dir
 * holds exactly these after boot and after a prompt): its credential store, the lock
 * proper-lockfile takes next to it, and the models catalog store.
 */
export const PI_OWN_FILES: ReadonlySet<string> = new Set([
  "auth.json",
  "auth.json.lock",
  "models-store.json",
]);

/** Entries in the runtime dir and its `agent/` that neither the agent nor Pi wrote (the tripwire). */
export async function unexpectedEntries(runtimeDir: string): Promise<string[]> {
  const found: string[] = [];
  const top = await readdir(runtimeDir).catch(() => undefined);
  if (top === undefined) return ["<runtime dir missing>"];
  for (const name of top) {
    if (name !== AGENT_SUBDIR && name !== MODEL_FILE_NAME && !isModelTemp(name)) found.push(name);
  }
  const agent = await readdir(path.join(runtimeDir, AGENT_SUBDIR)).catch(() => undefined);
  if (agent === undefined) return [...found, `<${AGENT_SUBDIR} missing>`];
  for (const name of agent) if (!PI_OWN_FILES.has(name)) found.push(`${AGENT_SUBDIR}/${name}`);
  return found;
}

/** A temp file of this agent's own model-file writer (`model.json.<hex>.tmp`). */
function isModelTemp(name: string): boolean {
  return /^model\.json\.[0-9a-f]{16}\.tmp$/.test(name);
}

/**
 * Start-up sweep: removes every per-process directory a previous agent left behind (it died
 * before its Pi exited, or the pod restarted), so no stale token or config outlives its process.
 * Returns the number of directories removed.
 */
export async function sweepRuntimeDir(runtimeDir: string): Promise<number> {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  let removed = 0;
  for (const name of await readdir(runtimeDir)) {
    if (!name.startsWith(RUNTIME_DIR_PREFIX)) continue;
    await rm(path.join(runtimeDir, name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
