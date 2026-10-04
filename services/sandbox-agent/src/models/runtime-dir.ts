import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
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
  "models-store.json.lock",
]);

/** The locks proper-lockfile takes next to Pi's two stores: the only directories Pi makes. */
const PI_LOCK_DIRS: ReadonlySet<string> = new Set(["auth.json.lock", "models-store.json.lock"]);
export const PI_MODELS_STORE = "models-store.json";

type Kind = "file" | "dir" | "symlink" | "other" | "missing";

async function kindOf(file: string): Promise<Kind> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "dir";
    return "other";
  } catch {
    return "missing";
  }
}

/**
 * Entries in the runtime dir and its `agent/` that neither the agent nor Pi wrote, or that are
 * not what they should be (the tripwire): everything is checked with `lstat`, so a symlink, a
 * FIFO or a directory where a regular file belongs is reported too. Only Pi's lock may be a
 * directory; `agent` itself must be a real directory.
 */
export async function unexpectedEntries(runtimeDir: string): Promise<string[]> {
  const found: string[] = [];
  const top = await readdir(runtimeDir).catch(() => undefined);
  if (top === undefined) return ["<runtime dir missing>"];
  for (const name of top) {
    const kind = await kindOf(path.join(runtimeDir, name));
    if (name === AGENT_SUBDIR) {
      if (kind !== "dir") found.push(`${name} (${kind})`);
    } else if (name === MODEL_FILE_NAME || isModelTemp(name)) {
      if (kind !== "file") found.push(`${name} (${kind})`);
    } else {
      found.push(name);
    }
  }
  const agent = await readdir(path.join(runtimeDir, AGENT_SUBDIR)).catch(() => undefined);
  if (agent === undefined) return [...found, `<${AGENT_SUBDIR} missing>`];
  for (const name of agent) {
    const kind = await kindOf(path.join(runtimeDir, AGENT_SUBDIR, name));
    const expected: Kind | undefined = PI_LOCK_DIRS.has(name)
      ? "dir"
      : PI_OWN_FILES.has(name)
        ? "file"
        : undefined;
    if (expected === undefined) found.push(`${AGENT_SUBDIR}/${name}`);
    else if (kind !== expected) found.push(`${AGENT_SUBDIR}/${name} (${kind})`);
  }
  return found;
}

/** A temp file of this agent's own model-file writer (`model.json.<hex>.tmp`). */
function isModelTemp(name: string): boolean {
  return /^model\.json\.[0-9a-f]{16}\.tmp$/.test(name);
}

/**
 * Pi's model catalog store, canonicalised (sorted keys), or null when absent or unreadable. Pi
 * reads it back on every refresh (`models-store.json`) and may rewrite it itself with the same
 * data during its start-up refresh, so the tripwire compares content, not bytes, and requires it
 * unchanged since Pi became ready.
 */
export async function piModelsStoreText(runtimeDir: string): Promise<string | null> {
  const file = path.join(runtimeDir, AGENT_SUBDIR, PI_MODELS_STORE);
  if ((await kindOf(file)) !== "file") return null;
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    return canonical(JSON.parse(text));
  } catch {
    return `<unparsable:${text}>`;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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
