import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
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
 * Layout: `<root>/sk-<sha256>/` is the content of one canonical bundle, extracted once under a
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

export class SkillStore {
  readonly #o: SkillStoreOptions;
  /** Hashes each live thread's current Pi was asked to load. */
  readonly #wanted = new Map<string, ReadonlySet<string>>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: SkillStoreOptions) {
    this.#o = options;
  }

  /** Boot: checks the root and empties it (an earlier agent's skills are stale by definition). */
  async init(): Promise<void> {
    await ensureRuntimeRoot(this.#o.root, this.#o.identities);
    await this.#sweep(() => true);
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
    return path.join(this.#o.root, `${DIR_PREFIX}${sha256}`);
  }

  async #prepare(threadId: string, refs: readonly SkillBundleRef[]): Promise<readonly string[]> {
    checkRefs(refs);
    await ensureRuntimeRoot(this.#o.root, this.#o.identities);
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
    const temp = path.join(this.#o.root, `${TEMP_PREFIX}${randomBytes(8).toString("hex")}`);
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
    for (const name of await readdir(this.#o.root)) {
      if (!name.startsWith(DIR_PREFIX) && !name.startsWith(TEMP_PREFIX)) continue;
      if (!remove(name)) continue;
      try {
        await rm(path.join(this.#o.root, name), { recursive: true, force: true });
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
