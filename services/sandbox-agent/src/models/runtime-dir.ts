import { constants as FS } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { EGRESS_TOKEN_FILE_NAME, isEgressTemp } from "../egress/egress-wiring.js";
import { SYSTEM_PROMPT_FILE_NAME } from "../pi/system-prompt-file.js";
import type { PiIdentities } from "../pi/identities.js";

/**
 * The per-process runtime directories (threads/thread.ts): `<runtimeDir>/pi-XXXXXX/` with `agent/`
 * (Pi's `PI_CODING_AGENT_DIR`), `model.json` and (KOBE-39) `egress-token`. Under a Pi identity (KOBE-71) the directory
 * belongs to the agent with the Pi's own group (only that Pi reads it, and it writes only
 * `agent/`), and the root is one Pi identities cannot rename (`ensureRuntimeRoot`), so another
 * thread's tools cannot touch it at all. Without one (the agent's own uid, as before KOBE-71) a
 * sibling process of the same user could write into it, which the tripwire (`unexpectedEntries`)
 * detects. Either way the agent sweeps leftovers of earlier agents at start-up.
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
 * FIFO or a directory where a regular file belongs is reported too. Only Pi's locks may be
 * directories; `agent` itself must be a real directory. An expected entry that vanished between
 * `readdir` and `lstat` (the agent's temp file renamed into place, a lock Pi released) is fine.
 */
export async function unexpectedEntries(runtimeDir: string): Promise<string[]> {
  const found: string[] = [];
  const top = await readdir(runtimeDir).catch(() => undefined);
  if (top === undefined) return ["<runtime dir missing>"];
  for (const name of top) {
    const kind = await kindOf(path.join(runtimeDir, name));
    if (name === AGENT_SUBDIR) {
      if (kind !== "dir") found.push(`${name} (${kind})`);
    } else if (
      name === MODEL_FILE_NAME ||
      isModelTemp(name) ||
      name === EGRESS_TOKEN_FILE_NAME ||
      name === SYSTEM_PROMPT_FILE_NAME ||
      isEgressTemp(name)
    ) {
      if (kind !== "file" && kind !== "missing") found.push(`${name} (${kind})`);
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
    else if (kind !== expected && kind !== "missing") {
      found.push(`${AGENT_SUBDIR}/${name} (${kind})`);
    }
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
  // Opened, then checked: the Pi's tools can swap the file for a FIFO or a link at any moment.
  let text: string | null = null;
  try {
    const handle = await open(file, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
    try {
      if ((await handle.stat()).isFile()) text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
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
export async function sweepRuntimeDir(
  runtimeDir: string,
  options: { readonly identities?: PiIdentities | undefined } = {},
): Promise<number> {
  await ensureRuntimeRoot(runtimeDir, options.identities !== undefined);
  let removed = 0;
  for (const name of await readdir(runtimeDir)) {
    if (!name.startsWith(RUNTIME_DIR_PREFIX)) continue;
    // Best effort per entry: a directory planted in a shared (sticky) root must not keep the agent
    // from starting.
    const ok = await removeRuntimeDir(path.join(runtimeDir, name), options.identities).then(
      () => true,
      () => false,
    );
    if (ok) removed += 1;
  }
  return removed;
}

/**
 * The parent of every Pi's runtime directory. Without Pi identities: the agent's own, 0700. Under
 * Pi identities (KOBE-71) every Pi must reach its own directory through it, and no Pi identity
 * may rename it or anything above it: renaming a directory needs only write access to its parent
 * (no sticky bit), and a swapped path would hand a thread's Pi config to another thread. So the
 * root is either the agent's own (0711: reach, never list) or a root-owned sticky directory (a
 * memory-backed emptyDir, the pod's `/run/kobe-pi`; the sticky bit protects the agent's entries),
 * and every directory above it is sticky or writable by its owner only. A root that is neither,
 * or not a real directory, is refused.
 */
export async function ensureRuntimeRoot(runtimeDir: string, identities: boolean): Promise<void> {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const info = await lstat(runtimeDir);
  const uid = process.getuid?.();
  const own = uid === undefined || info.uid === uid;
  const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
  if (!info.isDirectory() || !(own || (identities && stickyRoot))) {
    throw new Error(`Pi runtime directory ${runtimeDir} is not the agent's own directory`);
  }
  if (own) await chmod(runtimeDir, identities ? 0o711 : 0o700);
  if (!identities) return;
  // The real path: links on the way (macOS /var) are judged by where they lead.
  const real = await realpath(runtimeDir);
  for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
    const above = await lstat(dir);
    const shared = (above.mode & 0o022) !== 0 && (above.mode & 0o1000) === 0;
    if (!above.isDirectory() || shared) {
      throw new Error(
        `Pi runtime directory ${runtimeDir}: ${dir} lets other users rename what is in it ` +
          "(use a directory on a sticky volume, such as the pod's /run/kobe-pi)",
      );
    }
    if (dir === path.dirname(dir)) break;
  }
}

/**
 * Remove one Pi's runtime directory. Under a Pi identity a tool may have left owner-only
 * directories in it the agent cannot remove: those go as the identity that owns the directory's
 * group (the Pi's uid), then the rest as the agent.
 */
export async function removeRuntimeDir(dir: string, identities?: PiIdentities): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
    return;
  } catch (error) {
    if (identities === undefined) throw error;
  }
  // The Pi's group (the agent's directories), or the owner (a directory a Pi identity made).
  const info = await lstat(dir);
  const identity = identities.byGid(info.gid) ?? identities.byGid(info.uid);
  if (identity === undefined)
    throw new Error(`cannot remove ${dir}: not a Pi identity's directory`);
  await identities.removeContents(identity, dir);
  await rm(dir, { recursive: true, force: true });
}
