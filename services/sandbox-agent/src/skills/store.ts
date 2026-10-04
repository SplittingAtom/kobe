import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { SKILL_BUNDLE_MAX_BYTES, type SkillBundleRef } from "@kobe/protocol";
import { ensureRuntimeRoot } from "../models/runtime-dir.js";
import { BundleError, readBundle, type BundleLimits } from "./bundle.js";
import { extractFiles, SKILL_DIR_MODE } from "./extract.js";

/**
 * Where a run's effective skills live in the sandbox (KOBE-82, D22), and the only code that puts
 * them there. The directory belongs to the agent (kobe-sandbox-agent, not a Pi identity): skills
 * are written with modes the Pi uids can read but not change (extract.ts), under a root no Pi uid
 * can rename (`ensureRuntimeRoot`, the same rule as the Pi runtime directories, KOBE-71), so a
 * tool can never alter a skill for a later session.
 *
 * Layout: `<root>/store/sk-<sha256>/` is the content of one canonical bundle, extracted once under a
 * temporary name and renamed into place (a directory with that name is always complete). Pi is
 * pointed at exactly the directories of its run (`--skill`), so what a thread sees is what the
 * server listed; directories no live thread wants any more are removed on every start (nothing
 * stale), and the whole root is emptied when the agent boots.
 */

const DIR_PREFIX = "sk-";
const TEMP_PREFIX = ".tmp-";
/** All skills of all live threads together: the pod's skills volume is memory-backed. */
export const MAX_SKILLS_BYTES = 96 * 1024 * 1024;

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillError";
  }
}

/** Downloads the canonical zip with this hash from the server (never from object storage). */
export type BundleFetcher = (sha256: string, size: number) => Promise<Uint8Array>;

export interface SkillStoreOptions {
  readonly root: string;
  /** Pi identities in use (KOBE-71): the root must then be one they cannot rename in. */
  readonly identities: boolean;
  readonly fetch: BundleFetcher;
  readonly limits?: BundleLimits;
  readonly log?: { warn(obj: object, msg: string): void };
}

/** The agent's own subdirectory of the skills volume: the only place skills are written. */
export const STORE_DIR = "store";
/** Others may reach `sk-*` paths they are given, never list the store or create entries in it. */
const STORE_MODE = 0o711;

export class SkillStore {
  readonly #o: SkillStoreOptions;
  readonly #store: string;
  /** Hashes each live thread's current Pi was asked to load. */
  readonly #wanted = new Map<string, ReadonlySet<string>>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: SkillStoreOptions) {
    this.#o = options;
    this.#store = path.join(options.root, STORE_DIR);
  }

  /** Boot: checks the root and empties it (an earlier agent's skills are stale by definition). */
  async init(): Promise<void> {
    await this.#ensureStore();
    await this.#sweep(() => true);
  }

  /**
   * The volume root is a sticky directory every Pi uid can write to (a memory emptyDir), so
   * nothing is stored in it directly: the agent makes its own subdirectory (0711: no one else can
   * create, list, rename or delete anything in it; the sticky bit keeps it from being renamed away).
   * One left by an earlier run of this agent (a container restart keeps the volume) is reused; one
   * that is not the agent's own, or not a plain directory, is refused, never adopted.
   */
  async #ensureStore(): Promise<void> {
    await ensureRuntimeRoot(this.#o.root, this.#o.identities);
    let info = await lstat(this.#store).catch(() => undefined);
    if (info === undefined) {
      await mkdir(this.#store, { mode: STORE_MODE });
      info = await lstat(this.#store);
    }
    const uid = process.getuid?.();
    if (!info.isDirectory() || (uid !== undefined && info.uid !== uid))
      throw new SkillError(`${this.#store} is not the agent's own directory`);
    await chmod(this.#store, STORE_MODE);
  }

  /**
   * Makes exactly `refs` present for `threadId` and returns their directories in order (for
   * `--skill`). Everything the live threads no longer want is removed. Serialized: one start at a
   * time touches the directory.
   */
  prepare(threadId: string, refs: readonly SkillBundleRef[]): Promise<readonly string[]> {
    const run = this.#queue.then(() => this.#prepare(threadId, refs));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** The thread's Pi is gone: its skills may be removed at the next start. */
  release(threadId: string): void {
    this.#wanted.delete(threadId);
  }

  dirOf(sha256: string): string {
    return path.join(this.#store, `${DIR_PREFIX}${sha256}`);
  }

  async #prepare(threadId: string, refs: readonly SkillBundleRef[]): Promise<readonly string[]> {
    checkRefs(refs);
    await this.#ensureStore();
    const wanted = new Set(refs.map((r) => r.sha256));
    // Everything this start does not need goes first: it makes room and means a failed download
    // below never leaves a skill the server no longer lists.
    this.#wanted.set(threadId, wanted);
    await this.#sweep((name) => !this.#isWanted(name));
    const dirs: string[] = [];
    for (const ref of refs) dirs.push(await this.#materialize(ref));
    return dirs;
  }

  #isWanted(dirName: string): boolean {
    if (!dirName.startsWith(DIR_PREFIX)) return false;
    const hash = dirName.slice(DIR_PREFIX.length);
    for (const set of this.#wanted.values()) if (set.has(hash)) return true;
    return false;
  }

  async #materialize(ref: SkillBundleRef): Promise<string> {
    const final = this.dirOf(ref.sha256);
    if (await isOwnDirectory(final)) return final;
    const bytes = await this.#download(ref);
    let files;
    try {
      files = readBundle(bytes, this.#o.limits);
    } catch (error) {
      if (error instanceof BundleError)
        throw new SkillError(`skill ${ref.name} was refused (${error.reason}): ${error.message}`);
      throw error;
    }
    const temp = path.join(this.#store, `${TEMP_PREFIX}${randomBytes(8).toString("hex")}`);
    await mkdir(temp, { mode: SKILL_DIR_MODE });
    try {
      await extractFiles(temp, files);
      await rename(temp, final);
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw new SkillError(`skill ${ref.name} could not be written: ${(error as Error).message}`);
    }
    return final;
  }

  /** Bytes from the server, accepted only if size and SHA-256 are exactly what the server listed. */
  async #download(ref: SkillBundleRef): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      bytes = await this.#o.fetch(ref.sha256, ref.size);
    } catch (error) {
      throw new SkillError(`skill ${ref.name} could not be fetched: ${(error as Error).message}`);
    }
    if (bytes.length !== ref.size)
      throw new SkillError(`skill ${ref.name} has the wrong size (hash check refused)`);
    if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256)
      throw new SkillError(`skill ${ref.name} does not match its SHA-256 (refused)`);
    return bytes;
  }

  async #sweep(remove: (name: string) => boolean): Promise<void> {
    for (const name of await readdir(this.#store)) {
      if (!name.startsWith(DIR_PREFIX) && !name.startsWith(TEMP_PREFIX)) continue;
      if (!remove(name)) continue;
      try {
        await rm(path.join(this.#store, name), { recursive: true, force: true });
      } catch (error) {
        // A stale skill that can't be removed must not be handed to Pi: refuse the start.
        throw new SkillError(
          `stale skill ${name} could not be removed: ${(error as Error).message}`,
        );
      }
    }
  }
}

function checkRefs(refs: readonly SkillBundleRef[]): void {
  const names = new Set<string>();
  let total = 0;
  for (const ref of refs) {
    if (names.has(ref.name)) throw new SkillError(`skill ${ref.name} is listed twice`);
    names.add(ref.name);
    if (ref.size > SKILL_BUNDLE_MAX_BYTES) throw new SkillError(`skill ${ref.name} is too large`);
    total += ref.size;
  }
  if (total > MAX_SKILLS_BYTES) throw new SkillError("the run's skills are too large together");
}

async function isOwnDirectory(dir: string): Promise<boolean> {
  try {
    const info = await lstat(dir);
    const uid = process.getuid?.();
    return info.isDirectory() && (uid === undefined || info.uid === uid);
  } catch {
    return false;
  }
}
