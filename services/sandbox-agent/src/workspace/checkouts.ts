import path from "node:path";
import { PROJECT_WORKSPACE_DIR } from "@kobe/protocol";
import {
  OWNED_DIR_MODE,
  PROJECTS_PREFIX,
  SHARED_DIR_MODE,
  holdAreaRoot,
  localProjectSlugs,
  openOwnedDir,
  walkOwned,
  type Checkouts,
  type HeldRoot,
} from "./fs.js";
import { shareOnVolume } from "./volume.js";

/**
 * Project checkouts on the volume (CM4, KOBE-580). While its slug is in the latest pull, a
 * checked-out `projects/<slug>/` is free area: group-writable (0775/0664), scanned and pushed.
 * When the slug leaves, the folder is relocked: the group's write bit goes first, what the agent
 * cannot lock is handed back to the sync (removed or moved out), and the sync then locks the rest
 * and brings back the head. Every walk here holds each folder open `O_NOFOLLOW` and enters only
 * the agent's own folders (fs.ts `walkOwned`): a tool that swaps a subfolder for a link, or
 * makes its own, never gets the agent to change anything through it.
 */

/** Runs `fn` on the held `projects/<slug>` folder; nothing when either is missing or not ours. */
async function withProjectFolder<T>(
  root: string,
  slug: string,
  fn: (folder: HeldRoot) => Promise<T>,
): Promise<T | undefined> {
  if (slug === "" || slug.includes("/") || slug === "." || slug === "..") return undefined;
  const top = await holdAreaRoot(root, PROJECT_WORKSPACE_DIR, false).catch(() => undefined);
  if (!top) return undefined;
  try {
    // `projects/` is the agent's and 0555: no tool can swap the slug's name under it, and the
    // slug folder is opened without following a link anyway.
    const folder = await openOwnedDir(root, path.join(top.dir, slug));
    if (!folder) return undefined;
    try {
      return await fn(folder);
    } finally {
      await folder.close();
    }
  } finally {
    await top.close();
  }
}

/**
 * A checkout began (CM2/CM4): folders 0775, files 0664, or 0775 when `executable` says so (a
 * locked file is 0444 whatever it was: the manifest knows). Bottom up, the slug folder last: the
 * folders above stay locked while their entries are changed, so nothing in the part being walked
 * can be swapped. Only the agent's own entries change; `projects/` stays locked. Idempotent.
 */
export async function unlockCheckout(
  root: string,
  slug: string,
  executable: (rel: string) => boolean = () => false,
): Promise<void> {
  await withProjectFolder(root, slug, async (folder) => {
    await walkOwned(root, folder.dir, `${PROJECTS_PREFIX}${slug}`, {
      file: (abs, rel) => shareOnVolume(root, abs, executable(rel) ? 0o775 : 0o664),
      leave: (dir) => dir.setMode(SHARED_DIR_MODE).catch(() => {}),
    });
    await folder.setMode(SHARED_DIR_MODE).catch(() => {});
  });
}

/** An entry the agent cannot lock in an ended checkout (see {@link relockCheckout}). */
export interface ForeignEntry {
  /** Workspace-relative. */
  readonly rel: string;
  readonly kind: "file" | "dir" | "other";
}

/**
 * A checkout ended (CM4): takes the group's write bit off the project folder, top down (each
 * folder before its entries are looked at), so no tool can add, remove or swap anything in it
 * from here on, and returns what the agent cannot lock (outermost only): entries another uid
 * made while the folder was writable (a tool's file or folder: the agent may not chmod them, and
 * their owner could keep writing), links and special files.
 */
export async function relockCheckout(root: string, slug: string): Promise<ForeignEntry[]> {
  const foreign: ForeignEntry[] = [];
  await withProjectFolder(root, slug, async (folder) => {
    await folder.setMode(OWNED_DIR_MODE).catch(() => {});
    await walkOwned(root, folder.dir, `${PROJECTS_PREFIX}${slug}`, {
      enter: (dir) => dir.setMode(OWNED_DIR_MODE).catch(() => {}),
      foreign: (rel, kind) => foreign.push({ rel, kind }),
    });
  });
  return foreign;
}

/** What {@link applyCheckouts} needs from the sync. */
export interface CheckoutSyncDeps {
  readonly root: string;
  /** Whether the manifest row of `rel` is executable (unlock modes). */
  readonly executable: (rel: string) => boolean;
  /** Whether the server knows `rel` (a live row or a tombstone). */
  readonly known: (rel: string) => boolean;
  /** Removes a file (never a folder). */
  readonly remove: (rel: string) => Promise<void>;
  /** Moves an entry out of the read-only area (`kobe-moved/…`), never losing it. */
  readonly evict: (rel: string) => Promise<void>;
}

/**
 * The checkouts of a pull take effect. A slug that left is relocked: what the agent cannot lock
 * is removed (a tool's file at a path the server knows: the head comes back) or moved out (all
 * else the server never had); the caller locks the rest and brings it back to the head. A new
 * slug is unlocked. `everyFolder` (a restore: the sandbox may have slept through a Discard)
 * relocks every local project folder not listed and unlocks every listed one. Returns the slugs
 * that left.
 */
export async function applyCheckouts(
  deps: CheckoutSyncDeps,
  previous: Checkouts,
  next: Checkouts,
  everyFolder: boolean,
): Promise<string[]> {
  const candidates = everyFolder ? await localProjectSlugs(deps.root) : [...previous];
  const ended = candidates.filter((slug) => !next.has(slug));
  for (const slug of ended) {
    for (const { rel, kind } of await relockCheckout(deps.root, slug)) {
      if (kind === "file" && deps.known(rel)) await deps.remove(rel);
      else await deps.evict(rel);
    }
  }
  for (const slug of next) {
    if (everyFolder || !previous.has(slug)) await unlockCheckout(deps.root, slug, deps.executable);
  }
  return ended;
}
