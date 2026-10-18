import { canonicalZip, checkPackagePaths } from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import type { ScanResult } from "@kobe/skill-scanner";
import { ScanBusyError, ScanCancelledError, scanPool } from "../scan-pool.js";
import { readAllFiles, visibleDraft } from "./records.js";
import type { DraftContext } from "./service.js";

/**
 * The live scan preview of a draft (KOBE-321, SK12; review S1–S3). Its verdict is the save's:
 * the same worker, limits and rules in the shared pool (`preview: true`: never queued, and it
 * gives its slot up to any upload or save). Per request, in order:
 *
 *  1. a cheap read of the draft's revision (visibility first: one the caller can't see is not
 *     found); a scan of that revision already made, or running, is reused, for free;
 *  2. busy when the pool has no free slot (and the caller holds none to take back);
 *  3. the caller's slot is claimed (synchronously, before any wait), then the rate limit
 *     (`admit`), so polling or a busy pod costs nothing;
 *  4. the caller's older preview (another revision or draft) is cancelled and awaited: the
 *     newest request wins, so a slow scan never holds a typist's next one back, and one author
 *     runs at most one preview at a time (previews are outside the pool's per-owner share);
 *  5. the files are read and zipped, and the scan runs.
 *
 * Only complete scans are cached. A scan that ran out of time or memory is `unavailable` (the
 * page retries; the save scans in full), never a cached Block; files that don't form a package
 * are a `package_problem` (the save refuses them with the same reason), not a verdict.
 */

export type PreviewScan =
  | { readonly ok: true; readonly rev: number; readonly scan: ScanResult }
  | {
      readonly ok: false;
      readonly error: "not_found" | "rate_limited" | "busy" | "unavailable";
    }
  | { readonly ok: false; readonly error: "package_problem"; readonly message: string };

const CACHE_MAX = 128;
/** Complete scans per (team, draft, revision): every change moves a draft to a new revision. */
const cache = new Map<string, ScanResult>();
/** Scans running now, per (team, draft, revision): a second request for one joins it. */
const inflight = new Map<string, Promise<PreviewScan>>();
interface Claim {
  readonly key: string;
  readonly abort: AbortController;
  readonly done: Promise<PreviewScan>;
}
/** Each caller's newest preview, per (team, user): a newer one cancels it. */
const newest = new Map<string, Claim>();

function remember(key: string, scan: ScanResult): void {
  cache.set(key, scan);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Empties the preview cache (tests). */
export function clearPreviewCache(): void {
  cache.clear();
}

/** Rules whose Block says the scan didn't finish, not what the files hold. */
const INCOMPLETE = new Set(["scan-incomplete", "scan-resources-exceeded"]);
const incomplete = (scan: ScanResult) => scan.findings.some((f) => INCOMPLETE.has(f.rule));

export interface PreviewOptions {
  /** Counts the request against the caller's rate; false: refused. Called on a cache miss only. */
  readonly admit: () => Promise<boolean>;
  /** The request's own signal (the client went away). */
  readonly signal?: AbortSignal;
}

export async function previewDraftScan(
  ctx: DraftContext,
  id: string,
  options: PreviewOptions,
): Promise<PreviewScan> {
  const draft = await withTeam(ctx.db, ctx.teamId, (tx) =>
    visibleDraft(tx, ctx.teamId, id, ctx.viewer),
  );
  if (!draft) return { ok: false, error: "not_found" };
  const key = `${ctx.teamId}/${id}/${draft.rev}`;
  const hit = cache.get(key);
  if (hit) return { ok: true, rev: draft.rev, scan: hit };
  const running = inflight.get(key);
  if (running) return running;
  const owner = `${ctx.teamId}/${ctx.viewer.userId}`;
  const older = newest.get(owner);
  // The caller's own request for this revision, still waiting to start: join it.
  if (older?.key === key) return older.done;
  // No slot and none of the caller's own to take back: busy, before the rate or any file read.
  if (!older && scanPool().canStartPreview?.() === false) return { ok: false, error: "busy" };

  // The caller's slot is claimed before any wait (review S1): a request sent alongside this one
  // finds it and cancels it, so one author never runs two previews at once.
  const abort = new AbortController();
  options.signal?.addEventListener("abort", () => abort.abort(), { once: true });
  const done = startPreview(ctx, id, draft.rev, key, older, abort.signal, options.admit);
  const mine = { key, abort, done };
  newest.set(owner, mine);
  try {
    return await done;
  } finally {
    if (newest.get(owner) === mine) newest.delete(owner);
  }
}

/** The rate, then the older preview's end, then the scan (unless a newer request took over). */
async function startPreview(
  ctx: DraftContext,
  id: string,
  rev: number,
  key: string,
  older: Claim | undefined,
  signal: AbortSignal,
  admit: () => Promise<boolean>,
): Promise<PreviewScan> {
  if (!(await admit())) return { ok: false, error: "rate_limited" };
  if (older) {
    older.abort.abort();
    await older.done.catch(() => undefined);
  }
  if (signal.aborted) return { ok: false, error: "busy" };
  const scan = runPreview(ctx, id, rev, signal);
  inflight.set(key, scan);
  try {
    return await scan;
  } finally {
    if (inflight.get(key) === scan) inflight.delete(key);
  }
}

async function runPreview(
  ctx: DraftContext,
  id: string,
  rev: number,
  signal: AbortSignal,
): Promise<PreviewScan> {
  const loaded = await withTeam(ctx.db, ctx.teamId, async (tx) => {
    const draft = await visibleDraft(tx, ctx.teamId, id, ctx.viewer);
    return draft ? { rev: draft.rev, files: await readAllFiles(tx, ctx.teamId, id) } : null;
  });
  if (!loaded) return { ok: false, error: "not_found" };
  if (signal.aborted) return { ok: false, error: "busy" };
  // The package rules on paths alone, before any bytes are zipped (the save checks the same).
  const problem = checkPackagePaths(loaded.files.keys()).find(
    (p) => p.problem !== "skill_md_missing",
  );
  if (problem)
    return {
      ok: false,
      error: "package_problem",
      message: `${problem.path || "A path"} can't be in a skill (${problem.problem.replaceAll("_", " ")}).`,
    };
  if (!loaded.files.has("SKILL.md"))
    return {
      ok: false,
      error: "package_problem",
      message: "The draft needs a SKILL.md at its root.",
    };
  try {
    const result = await scanPool().scan(canonicalZip(loaded.files), {
      owner: ctx.viewer.userId,
      preview: true,
      signal,
    });
    if (incomplete(result)) return { ok: false, error: "unavailable" };
    // Cached under the revision actually read (a write may have landed since the first read).
    remember(`${ctx.teamId}/${id}/${loaded.rev}`, result);
    return { ok: true, rev: loaded.rev, scan: result };
  } catch (err) {
    if (err instanceof ScanBusyError || err instanceof ScanCancelledError)
      return { ok: false, error: "busy" };
    throw err;
  }
}
