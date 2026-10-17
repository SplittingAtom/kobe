import { lstat, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  isExcludedPath,
  isServerOwnedPath,
  workspacePathIssue,
  type WorkspaceMoveRecord,
} from "@kobe/protocol";
import { openAgentTemp, tempPathFor } from "../atomic-file.js";
import type { WireLogger } from "../wire/client.js";
import type { SyncClient } from "./client.js";
import { ensureParents, parentsAreDirs, pruneEmptyParents } from "./fs.js";
import { assertOnVolume } from "./volume.js";

/**
 * Server moves as local renames (KOBE-304 review S1–S3). The file browser's move changes the
 * manifest only; the server journals it (`GET moves`). Before each pull (and before the restore
 * on wake) the agent renames each journalled source to its destination on the volume, the whole
 * tree at once: unsynced edits, skipped caches (`node_modules`, `.venv`) and never-synced files
 * move with it, nothing is downloaded again and the volume never holds two copies. The pull that
 * follows finds the moved files already in place.
 *
 * A rename is refused (and the pull alone converges, as for an agent without this) when a path is
 * not the agent's own (server-owned areas, `.kobe/`), when either side or any parent is a symlink
 * or not a directory, when the real parent directories are not where they should be under the
 * volume's real root, or when the destination already exists locally. A replayed move whose
 * source is gone is a no-op: replay is idempotent.
 */

export type LocalMoveOutcome = "renamed" | "absent" | "exists" | "refused";

const own = (rel: string) =>
  workspacePathIssue(rel) === undefined && !isExcludedPath(rel) && !isServerOwnedPath(rel);

/** The real directory of `rel`'s parent is exactly `realRoot/<parent>` (no link anywhere). */
async function parentIsReal(root: string, realRoot: string, rel: string): Promise<boolean> {
  const parent = path.posix.dirname(rel);
  const want = parent === "." ? realRoot : path.join(realRoot, parent);
  const got = await realpath(parent === "." ? root : path.join(root, parent)).catch(() => "");
  return got === want;
}

/** Every parent of `rel` that exists is a real directory (missing ones are created later). */
async function existingParentsAreDirs(root: string, rel: string): Promise<boolean> {
  let current = root;
  for (const part of rel.split("/").slice(0, -1)) {
    current = path.join(current, part);
    const stat = await lstat(current).catch(() => undefined);
    if (!stat) return true;
    if (!stat.isDirectory()) return false;
  }
  return true;
}

/** Renames `from` to `to` on the volume, symlink-safe. */
export async function applyLocalMove(
  root: string,
  move: Pick<WorkspaceMoveRecord, "from" | "to" | "type">,
): Promise<LocalMoveOutcome> {
  const { from, to } = move;
  if (!own(from) || !own(to) || to === from || to.startsWith(`${from}/`)) return "refused";
  if (!(await parentsAreDirs(root, from))) return "absent";
  const src = await lstat(path.join(root, from)).catch(() => undefined);
  if (!src) return "absent";
  if (src.isSymbolicLink()) return "refused";
  if (move.type === "dir" ? !src.isDirectory() : !src.isFile()) return "refused";
  if (!(await existingParentsAreDirs(root, to))) return "refused";
  if (await lstat(path.join(root, to)).catch(() => undefined)) return "exists";
  try {
    await ensureParents(root, to);
  } catch {
    return "refused"; // a file or link in the way of the destination's folders
  }
  const realRoot = await realpath(root);
  if (!(await parentIsReal(root, realRoot, from)) || !(await parentIsReal(root, realRoot, to))) {
    return "refused";
  }
  try {
    // rename(2) moves the entry itself: a link inside the tree is moved, never followed.
    await rename(path.join(root, from), path.join(root, to));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? "absent"
      : code === "EEXIST" || code === "ENOTEMPTY"
        ? "exists"
        : "refused";
  }
  await pruneEmptyParents(root, from);
  return "renamed";
}

/** Something is at `rel` (its parents real directories). */
async function present(root: string, rel: string): Promise<boolean> {
  if (!(await parentsAreDirs(root, rel))) return false;
  return (await lstat(path.join(root, rel)).catch(() => undefined)) !== undefined;
}

/** Where the agent remembers the last revision it pulled, for the replay on wake. */
const STATE_DIR = ".kobe";
const STATE_FILE = "workspace-sync.json";

export interface AppliedMove {
  readonly from: string;
  readonly to: string;
  /**
   * Renamed by this replay. False: renamed before (its source is gone and its destination is
   * there), e.g. by a restore attempt that then failed, or before a crash (review R1).
   */
  readonly now: boolean;
}

/** Fetches journalled moves and applies them; remembers the last pulled revision on the volume. */
export class MoveReplay {
  readonly #root: string;
  readonly #client: SyncClient;
  readonly #logger: WireLogger;

  constructor(root: string, client: SyncClient, logger: WireLogger) {
    this.#root = root;
    this.#client = client;
    this.#logger = logger;
  }

  /** Applies the moves with rows newer than `since`, oldest first; returns those renamed here. */
  async replay(since: number): Promise<AppliedMove[]> {
    const applied: AppliedMove[] = [];
    let after = 0;
    for (let page = 0; page < 100; page += 1) {
      const { moves, more } = await this.#client.moves(since, after);
      for (const move of moves) {
        const outcome = await applyLocalMove(this.#root, move).catch(() => "refused" as const);
        if (outcome === "renamed") applied.push({ from: move.from, to: move.to, now: true });
        else if (outcome === "absent" && (await present(this.#root, move.to))) {
          applied.push({ from: move.from, to: move.to, now: false });
        } else if (outcome === "exists" || outcome === "refused") {
          // The pull alone converges (download the new path, keep a conflicting local file).
          this.#logger.warn(
            { rev: move.rev, outcome },
            "server move not applied as a local rename",
          );
        }
        after = move.rev;
      }
      if (!more || moves.length === 0) break;
    }
    return applied;
  }

  /** The revision of the last complete pull saved on this volume (0: none). */
  async savedRev(): Promise<number> {
    try {
      if (!(await parentsAreDirs(this.#root, `${STATE_DIR}/${STATE_FILE}`))) return 0;
      const file = path.join(this.#root, STATE_DIR, STATE_FILE);
      if (!(await lstat(file)).isFile()) return 0;
      const value = JSON.parse(await readFile(file, "utf8")) as { seen_rev?: unknown };
      return Number.isSafeInteger(value.seen_rev) && (value.seen_rev as number) > 0
        ? (value.seen_rev as number)
        : 0;
    } catch {
      return 0;
    }
  }

  async save(seenRev: number): Promise<void> {
    try {
      const dir = path.join(this.#root, STATE_DIR);
      const stat = await lstat(dir).catch(() => undefined);
      if (!stat) await mkdir(dir, { mode: 0o700 });
      else if (!stat.isDirectory()) return;
      // Written on the volume only: a `.kobe` swapped for a link must not make the agent write
      // into an agent-only directory elsewhere (KOBE-71 confused deputy, review nit).
      const final = path.join(dir, STATE_FILE);
      const temp = tempPathFor(final);
      const handle = await openAgentTemp(temp, 0o600);
      try {
        await assertOnVolume(handle, this.#root, temp);
        await handle.writeFile(JSON.stringify({ seen_rev: seenRev }));
        await handle.close();
        await rename(temp, final);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      this.#logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "could not remember the workspace revision",
      );
    }
  }
}
