import {
  FILE_SHARE_MAX_BYTES,
  WORKSPACE_SERVER_OWNED_PREFIXES,
  isExcludedPath,
  isServerOwnedPath,
  workspacePathIssue,
  type RunStartFrame,
  type WorkspaceChange,
  type WorkspaceChangeResult,
  type WorkspaceEntry,
} from "@kobe/protocol";
import { constants as FS } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { WireLogger } from "../wire/client.js";
import { SyncHttpError, type SyncClient } from "./client.js";
import {
  conflictCopyName,
  ensureParents,
  hashFile,
  lockServerOwned,
  openForUpload,
  removeFile,
  renameWithin,
  scanWorkspace,
  statLocal,
  writeFileAtomic,
  type LocalFile,
} from "./fs.js";

/**
 * kobe-sandbox-agent's side of workspace sync (KOBE-27, D13: the agent "syncs S3 ↔ /workspace").
 * The server brokers every byte (SyncClient); this class decides what moves:
 *
 * - **restore** (startup: a wake or a rebuild): full manifest vs the volume. Missing files are
 *   downloaded (an empty volume → a full restore), unchanged ones are kept without reading them
 *   (size + mtime), local edits newer than the copy are kept and pushed. Runs in parallel with
 *   the wire connection and Pi's start; `beforeRun` waits for it, so a run's first prompt never
 *   reaches Pi before the workspace is back.
 * - **pull** (before every run, and periodically): changes since the last seen revision — server
 *   writes such as uploads (`uploads/<thread>/`, KOBE-53) and project files (`projects/<slug>/`,
 *   KOBE-57), which are server-owned and read-only here.
 * - **push** (every interval, soon after a run ends, and when stopping for hibernation): local
 *   changes → upload content the server lacks → commit with each path's base revision.
 *
 * Conflict rule (contract): a newer server-written version keeps the path and the local edit is
 * kept beside it as `<name>.conflict-<time><ext>`; a deletion never beats a modification.
 */
export interface WorkspaceSyncOptions {
  readonly root: string;
  readonly client: SyncClient;
  readonly logger: WireLogger;
  /** Periodic push + pull; 0 disables sync entirely. */
  readonly intervalMs: number;
  /** Directory names never synced, anywhere (rebuildable caches). */
  readonly skipDirs?: readonly string[];
  readonly maxFiles?: number;
  /** Parallel uploads/downloads. */
  readonly concurrency?: number;
  /** How long `beforeRun` waits for a failing restore before letting the run start anyway. */
  readonly restoreWaitMs?: number;
  readonly now?: () => Date;
}

/** Last known state of a path in the durable copy (what the local file was synced from). */
interface Known {
  readonly rev: number;
  readonly deleted: boolean;
  readonly sha256?: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly executable: boolean;
  readonly origin: "sandbox" | "server";
  readonly updatedMs: number;
}

export interface RestoreStats {
  readonly mode: "full" | "incremental";
  readonly entries: number;
  readonly files: number;
  readonly bytes: number;
  readonly durationMs: number;
}

export interface PushStats {
  readonly changes: number;
  readonly uploaded: number;
  readonly bytes: number;
  readonly conflicts: number;
  readonly rejected: number;
}

/** The synced entry of one file: what `file.share` must name (files.ts, push-then-share). */
export interface PushedFile {
  readonly path: string;
  readonly rev: number;
  readonly sha256: string;
  readonly size: number;
}

/** `pushPath` could not leave the file synced; the message is shown to the model as a tool error. */
export class PushPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushPathError";
  }
}

export const DEFAULT_SKIP_DIRS = ["node_modules", "__pycache__", ".venv"] as const;
const COMMIT_BATCH = 250;
const MISSING_BATCH = 1000;
const RUN_END_DEBOUNCE_MS = 2_000;
const UNAVAILABLE_RETRY_MS = 5 * 60_000;
/** Where files found in a server-owned area that the server never wrote are moved (and kept). */
export const EVICTED_PREFIX = "kobe-moved/";

/** Errors that say nothing about one file: the server or the network. Retry the whole step. */
function isTransient(error: unknown): boolean {
  if (error instanceof SyncHttpError) {
    return (
      error.status === 0 || error.status === 429 || (error.status >= 500 && error.status !== 502)
    );
  }
  return error instanceof TypeError; // fetch: network failure
}

const known = (e: WorkspaceEntry): Known => ({
  rev: e.rev,
  deleted: e.deleted,
  ...(e.sha256 === undefined ? {} : { sha256: e.sha256 }),
  size: e.size,
  mtimeMs: e.mtime_ms,
  executable: e.executable,
  origin: e.origin,
  updatedMs: e.updated_ms,
});

/** Size and mtime match (the rsync heuristic: no need to read the file). */
const sameAs = (local: LocalFile, k: { size: number; mtimeMs: number }) =>
  local.size === k.size && Math.abs(local.mtimeMs - k.mtimeMs) <= 1;

/** Group-writable: every thread's Pi identity shares the workspace through its group (KOBE-71). */
const modeFor = (path: string, executable: boolean) =>
  isServerOwnedPath(path) ? 0o444 : executable ? 0o775 : 0o664;

/** Runs `fn` over `items`, `limit` at a time; waits for all, then rethrows the first failure. */
async function parallel<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (next < items.length && failure === undefined) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure.error;
}

type PlannedChange = WorkspaceChange & { readonly local?: LocalFile };

interface PushPlan {
  readonly changes: PlannedChange[];
  /** Content to upload (one change per hash). */
  readonly uploads: PlannedChange[];
}

export class WorkspaceSync {
  readonly #o: Required<Omit<WorkspaceSyncOptions, "skipDirs">> & { skipDirs: Set<string> };
  readonly #known = new Map<string, Known>();
  /** Local states the server refused (size/quota): not retried until the file changes. */
  readonly #refused = new Map<string, LocalFile>();
  /** Paths already reported unreadable (bounded). */
  readonly #unreadable = new Set<string>();
  #seenRev = 0;
  #chain: Promise<unknown> = Promise.resolve();
  /** Settles once the startup restore succeeded, or the server said it has no workspace sync. */
  #ready: Promise<void> | undefined;
  #settle: () => void = () => {};
  #restored = false;
  #timer: NodeJS.Timeout | undefined;
  #soon: NodeJS.Timeout | undefined;
  #stopped = false;
  #unavailable = false;
  #emptyAtStart: boolean | undefined;
  /** Files and bytes downloaded by restore attempts so far. */
  #restoredFiles = 0;
  #restoredBytes = 0;
  #restoreStarted = 0;
  /** Downloads that failed for this file only (missing object, something local in the way). */
  readonly #retry = new Map<string, WorkspaceEntry>();

  constructor(options: WorkspaceSyncOptions) {
    this.#o = {
      // Matches the server's per-sandbox limits (a few short transactions at a time).
      concurrency: 2,
      maxFiles: 200_000,
      restoreWaitMs: 60_000,
      now: () => new Date(),
      ...options,
      skipDirs: new Set(options.skipDirs ?? DEFAULT_SKIP_DIRS),
    };
  }

  get enabled(): boolean {
    return this.#o.intervalMs > 0 && !this.#unavailable;
  }

  /** Starts the restore (retried until it succeeds) and the periodic push + pull. */
  start(): void {
    if (this.#o.intervalMs <= 0) return;
    this.#ready = new Promise<void>((resolve) => {
      this.#settle = resolve;
    });
    void this.#restoreUntilDone().finally(() => this.#settle());
    this.#timer = setInterval(() => {
      if (!this.#restored || this.#stopped) return;
      void (async () => {
        await this.#push();
        await this.#serial(() => this.#pull());
      })().catch((error: unknown) => this.#warn("periodic workspace sync failed", error));
    }, this.#o.intervalMs);
    this.#timer.unref();
  }

  /**
   * Before a run's prompt reaches Pi (ThreadManager `beforeRun`): the restore is done (or has
   * failed for `restoreWaitMs`), the latest server writes are pulled, and the run's attachments
   * are present. A missing attachment fails the run.
   */
  async beforeRun(frame: RunStartFrame): Promise<void> {
    if (!this.enabled || this.#ready === undefined) return;
    const restored = await Promise.race([
      this.#ready.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), this.#o.restoreWaitMs).unref()),
    ]);
    if (!restored || !this.#restored) {
      if (this.enabled) {
        this.#o.logger.warn({}, "workspace restore still failing: starting the run without it");
      }
    } else {
      await this.#serial(() => this.#pull()).catch((error: unknown) =>
        this.#warn("workspace pull before the run failed", error),
      );
    }
    for (const attachment of frame.attachments ?? []) {
      const rel = attachment.path.startsWith(`${this.#o.root}/`)
        ? attachment.path.slice(this.#o.root.length + 1)
        : attachment.path;
      if ((await statLocal(this.#o.root, rel)) === undefined) {
        throw new Error(`attachment ${rel} is not in the workspace`);
      }
    }
  }

  /** A run ended: push its outputs soon (debounced). */
  runEnded(): void {
    if (!this.enabled || this.#stopped) return;
    clearTimeout(this.#soon);
    this.#soon = setTimeout(() => {
      if (!this.#restored) return;
      void this.#push().catch((error: unknown) =>
        this.#warn("workspace push after a run failed", error),
      );
    }, RUN_END_DEBOUNCE_MS);
    this.#soon.unref();
  }

  /** Final push before the sandbox stops (hibernation, shutdown), bounded by `deadlineMs`. */
  async flush(deadlineMs: number): Promise<PushStats | undefined> {
    this.#stopped = true;
    clearInterval(this.#timer);
    clearTimeout(this.#soon);
    if (!this.enabled || !this.#restored) return undefined;
    const push = this.#push();
    const timeout = new Promise<undefined>((r) =>
      setTimeout(() => r(undefined), deadlineMs).unref(),
    );
    try {
      const stats = await Promise.race([push, timeout]);
      if (stats === undefined) this.#o.logger.warn({ deadlineMs }, "workspace flush timed out");
      else this.#o.logger.info({ ...stats }, "workspace flushed");
      return stats;
    } catch (error) {
      this.#warn("workspace flush failed", error);
      return undefined;
    }
  }

  /** One push now (tests, operators). */
  push(): Promise<PushStats> {
    return this.#push();
  }

  /**
   * Pushes exactly one file now (blob + commit) and returns its entry, for `share_file`: the
   * server shares only a file whose live row has this `rev` and `sha256`. Nothing else is pushed.
   * The file is read without following links (a swapped symlink fails here, not later). Throws
   * {@link PushPathError} when it cannot be left synced (sync off, not a regular file, too large,
   * server refused, a newer server version won).
   */
  async pushPath(rel: string): Promise<PushedFile> {
    if (!this.enabled) throw new PushPathError("workspace sync is not available");
    if (isExcludedPath(rel) || rel.split("/").some((part) => this.#o.skipDirs.has(part))) {
      throw new PushPathError(`${rel} is not part of the synced workspace`);
    }
    await Promise.race([
      this.ready(),
      new Promise<void>((resolve) => setTimeout(resolve, this.#o.restoreWaitMs).unref()),
    ]);
    if (!this.#restored) throw new PushPathError("the workspace is still being restored");
    try {
      return await this.#pushOne(rel);
    } catch (error) {
      if (error instanceof PushPathError) throw error;
      this.#warn("push of one file failed", error);
      throw new PushPathError(`${rel} could not be pushed to the Kobe server`);
    }
  }

  async #pushOne(rel: string): Promise<PushedFile> {
    const planned = await this.#serial(async () => {
      const hashed = await hashFile(this.#o.root, rel);
      const local = await statLocal(this.#o.root, rel);
      if (hashed === undefined || local === undefined || hashed.size !== local.size) {
        throw new PushPathError(`${rel} is not a readable regular file (or it is changing)`);
      }
      if (hashed.size > FILE_SHARE_MAX_BYTES) throw new PushPathError(`${rel} is too large`);
      const k = this.#known.get(rel);
      if (k && !k.deleted && k.sha256 === hashed.sha256) {
        return { done: { path: rel, rev: k.rev, sha256: hashed.sha256, size: hashed.size } };
      }
      if (isServerOwnedPath(rel)) {
        throw new PushPathError(`${rel} is in a read-only area and differs from the server's copy`);
      }
      const change: PlannedChange = {
        op: "put",
        path: rel,
        base_rev: k?.rev ?? null,
        sha256: hashed.sha256,
        size: hashed.size,
        mtime_ms: local.mtimeMs,
        executable: local.executable,
        local,
      };
      const missing = await this.#o.client.missing([hashed.sha256]);
      return { change, upload: missing.length > 0 };
    });
    if ("done" in planned) return planned.done;
    const { change } = planned;
    if (planned.upload) {
      await this.#o.client.upload(
        change.sha256,
        await openForUpload(this.#o.root, rel),
        change.size,
      );
    }
    const outcome = await this.#serial(async () => {
      if ((this.#known.get(rel)?.rev ?? null) !== change.base_rev) return "stale";
      const { local: _local, ...wire } = change;
      const out = await this.#o.client.commit([wire]);
      const result = out.results[0];
      if (result === undefined) return "no result";
      let refused = false;
      await this.#applyResult(change, result, () => {}, () => (refused = true));
      if (refused) return "refused";
      const k = this.#known.get(rel);
      return k && !k.deleted && k.sha256 === change.sha256 ? k : "newer";
    });
    if (typeof outcome === "string") {
      throw new PushPathError(
        outcome === "newer"
          ? `${rel} was changed on the server meanwhile; your copy was kept beside it`
          : `${rel} could not be synced (${outcome}); try again`,
      );
    }
    return { path: rel, rev: outcome.rev, sha256: change.sha256, size: change.size };
  }

  /** One pull now (tests). */
  pull(): Promise<number> {
    return this.#serial(() => this.#pull());
  }

  /** Resolves once the startup restore succeeded. */
  ready(): Promise<void> {
    return this.#ready ?? Promise.resolve();
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  /**
   * A file a tool made owner-only (KOBE-71: tools run under Pi identities, the agent reads the
   * workspace through its group) cannot be pushed: say so once per path, never treat it as gone.
   */
  async #noteUnreadable(path: string): Promise<void> {
    if (this.#unreadable.has(path)) return;
    try {
      await access(join(this.#o.root, path), FS.R_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EACCES") return;
      if (this.#unreadable.size < 1000) this.#unreadable.add(path);
      this.#warn(
        `workspace file not synced: ${path} is not readable by the agent (owner-only mode)`,
        error,
      );
    }
  }

  #warn(message: string, error: unknown): void {
    this.#o.logger.warn({ err: error instanceof Error ? error.message : String(error) }, message);
  }

  async #restoreUntilDone(): Promise<void> {
    for (let attempt = 0; !this.#stopped; attempt++) {
      try {
        const stats = await this.#serial(() => this.#restore());
        this.#restored = true;
        this.#unavailable = false;
        this.#o.logger.info({ ...stats }, "workspace restored");
        await this.#o.client
          .restoreReport({
            mode: stats.mode,
            files: stats.files,
            bytes: stats.bytes,
            duration_ms: stats.durationMs,
          })
          .catch((error: unknown) => this.#warn("workspace restore report failed", error));
        return;
      } catch (error) {
        let delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)) * (0.5 + Math.random());
        if (error instanceof SyncHttpError && error.status === 404 && error.code !== "not_found") {
          // This server has no workspace sync (no object storage configured, or a replica from
          // before it): off for now, asked again later (runs do not wait meanwhile).
          if (!this.#unavailable) this.#o.logger.warn({}, "workspace sync is not available");
          this.#unavailable = true;
          this.#settle();
          delay = UNAVAILABLE_RETRY_MS;
        } else {
          this.#warn("workspace restore failed; retrying", error);
        }
        await new Promise((r) => setTimeout(r, delay).unref());
      }
    }
  }

  /**
   * Entries since a revision; `full` when this is a complete listing (from 0, or the server said
   * our revision is older than its horizon) — then a path missing from it no longer exists.
   */
  async #manifestSince(
    since: number,
  ): Promise<{ head: number; entries: WorkspaceEntry[]; full: boolean }> {
    const entries: WorkspaceEntry[] = [];
    let cursor = since;
    for (;;) {
      let page;
      try {
        page = await this.#o.client.manifest(cursor);
      } catch (error) {
        if (error instanceof SyncHttpError && error.code === "resync_required" && cursor > 0) {
          return this.#manifestSince(0);
        }
        throw error;
      }
      // Re-checked here: a path the agent must never write (its own area, an invalid name) is
      // ignored whatever the server says.
      entries.push(
        ...page.entries.filter(
          (e) => workspacePathIssue(e.path) === undefined && !isExcludedPath(e.path),
        ),
      );
      if (!page.more || page.entries.length === 0) {
        return { head: page.head_rev, entries, full: since === 0 };
      }
      cursor = page.entries[page.entries.length - 1]?.rev ?? page.head_rev;
    }
  }

  async #restore(): Promise<RestoreStats> {
    if (this.#restoreStarted === 0) this.#restoreStarted = Date.now();
    const local = await scanWorkspace(this.#o.root, {
      skipDirs: this.#o.skipDirs,
      maxFiles: this.#o.maxFiles,
    });
    const { head, entries } = await this.#manifestSince(0);
    // The newest row per path (a full listing has one per path; be safe anyway).
    const latest = new Map<string, WorkspaceEntry>();
    for (const e of entries) {
      const prev = latest.get(e.path);
      if (!prev || prev.rev < e.rev) latest.set(e.path, e);
    }
    // Whether the volume was empty when this process first looked (a retried restore sees the
    // files its failed attempt already wrote).
    this.#emptyAtStart ??= local.files.size === 0;
    const empty = this.#emptyAtStart;
    const downloads: WorkspaceEntry[] = [];
    for (const e of latest.values()) {
      const file = local.files.get(e.path);
      if (e.deleted) {
        // Only the deleted version itself is removed; a different local file is newer work.
        if (file && sameAs(file, { size: e.size, mtimeMs: e.mtime_ms })) {
          await removeFile(this.#o.root, e.path);
        }
        this.#known.set(e.path, known(e));
        continue;
      }
      if (file && sameAs(file, { size: e.size, mtimeMs: e.mtime_ms })) {
        this.#known.set(e.path, known(e));
        continue;
      }
      if (!file || isServerOwnedPath(e.path)) {
        downloads.push(e);
        continue;
      }
      // The volume and the copy differ. A sandbox-written row: the volume is newer work, keep it
      // (pushed next, based on this row). A server-written row (uploads, file browser): the
      // server's version wins unless the local file changed after it — then keep both.
      this.#known.set(e.path, known(e));
      if (e.origin === "server") {
        if (file.mtimeMs > e.updated_ms) await this.#conflictCopy(e.path);
        downloads.push(e);
      }
    }
    await parallel(downloads, this.#o.concurrency, async (e) => {
      const got = await this.#downloadSafely(e);
      if (got) {
        this.#restoredFiles += 1;
        this.#restoredBytes += got.size;
      }
    });
    // Server-owned areas mirror the server: what it never wrote is moved out (kept, then pushed).
    for (const path of local.files.keys()) {
      if (isServerOwnedPath(path) && !latest.has(path)) await this.#evict(path);
    }
    await lockServerOwned(this.#o.root, WORKSPACE_SERVER_OWNED_PREFIXES);
    this.#seenRev = head;
    const files = this.#restoredFiles;
    return {
      mode: empty && files > 0 ? "full" : "incremental",
      entries: latest.size,
      files,
      bytes: this.#restoredBytes,
      durationMs: Date.now() - this.#restoreStarted,
    };
  }

  async #download(path: string): Promise<{ size: number } | undefined> {
    const got = await this.#o.client.download(path);
    if (!got) {
      this.#known.delete(path); // gone meanwhile; the next pull brings its tombstone
      return undefined;
    }
    const { entry, body } = got;
    await writeFileAtomic(this.#o.root, path, body, {
      sha256: entry.sha256 ?? "",
      size: entry.size,
      mtimeMs: entry.mtime_ms,
      mode: modeFor(path, entry.executable),
    });
    this.#known.set(path, known(entry));
    return { size: entry.size };
  }

  /**
   * One file's download, failing only that file: a missing object or something local in the way
   * (a directory where the copy has a file) is logged and retried on later pulls, keeping the
   * local data; a server or network failure is rethrown (the whole step is retried).
   */
  async #downloadSafely(e: WorkspaceEntry): Promise<{ size: number } | undefined> {
    try {
      const got = await this.#download(e.path);
      this.#retry.delete(e.path);
      return got;
    } catch (error) {
      if (isTransient(error)) throw error;
      this.#retry.set(e.path, e);
      // Nothing to push or delete for this path until it is resolved.
      if (!this.#known.has(e.path)) this.#known.set(e.path, { ...known(e), rev: e.rev - 1 });
      this.#warn("workspace file not restored (kept the local state; retried later)", error);
      return undefined;
    }
  }

  /** A file in a server-owned area the server never wrote: moved to `kobe-moved/…`, never lost. */
  async #evict(path: string): Promise<void> {
    let target = `${EVICTED_PREFIX}${path}`;
    if ((await statLocal(this.#o.root, target)) !== undefined) {
      target = await conflictCopyName(this.#o.root, target, this.#o.now());
    }
    try {
      await ensureParents(this.#o.root, target);
      await ensureParents(this.#o.root, path); // makes the read-only parent writable
      await renameWithin(this.#o.root, path, target);
      this.#o.logger.info({}, "moved a file out of a read-only workspace area");
    } catch (error) {
      this.#warn("could not move a file out of a read-only area", error);
    }
  }

  async #conflictCopy(path: string): Promise<void> {
    const copy = await conflictCopyName(this.#o.root, path, this.#o.now());
    await renameWithin(this.#o.root, path, copy);
    this.#o.logger.info({}, "workspace conflict: kept the local version as a conflict copy");
  }

  async #pull(): Promise<number> {
    const { head, entries, full } = await this.#manifestSince(this.#seenRev);
    let applied = 0;
    if (full && this.#seenRev > 0) applied += await this.#dropUnlisted(entries, head);
    for (const [path, e] of [...this.#retry]) {
      if (entries.some((n) => n.path === path)) continue; // a newer row is in this pull
      if (await this.#downloadSafely(e)) applied += 1;
    }
    const touchedOwned = entries.some((e) => isServerOwnedPath(e.path));
    for (const e of entries) {
      const k = this.#known.get(e.path);
      if (k && k.rev >= e.rev) continue; // our own write, or already applied
      const file = await statLocal(this.#o.root, e.path);
      const unchanged =
        file === undefined
          ? k === undefined || k.deleted
          : k !== undefined && !k.deleted && sameAs(file, k);
      const owned = isServerOwnedPath(e.path);
      if (e.deleted) {
        if (file && (unchanged || owned)) await removeFile(this.#o.root, e.path);
        this.#known.set(e.path, known(e));
        applied += 1;
        continue;
      }
      if (file && !unchanged && !owned) {
        const local = await hashFile(this.#o.root, e.path);
        if (local?.sha256 === e.sha256) {
          this.#known.set(e.path, known({ ...e, mtime_ms: file.mtimeMs }));
          continue;
        }
        await this.#conflictCopy(e.path);
      }
      if (await this.#downloadSafely(e)) applied += 1;
    }
    if (touchedOwned) await lockServerOwned(this.#o.root, WORKSPACE_SERVER_OWNED_PREFIXES);
    this.#seenRev = Math.max(this.#seenRev, head);
    return applied;
  }

  /**
   * After a resync (our revision fell behind the server's horizon: its tombstones were purged), a
   * known path absent from the full listing was deleted on the server. Same rule as a tombstone:
   * the local file goes if it is still the version we knew (always in read-only areas); a local
   * modification is kept and pushed as a new file.
   */
  async #dropUnlisted(entries: readonly WorkspaceEntry[], head: number): Promise<number> {
    const listed = new Set(entries.map((e) => e.path));
    let dropped = 0;
    for (const [path, k] of [...this.#known]) {
      if (k.deleted || listed.has(path) || this.#retry.has(path)) continue;
      const file = await statLocal(this.#o.root, path);
      if (file && !sameAs(file, k) && !isServerOwnedPath(path)) {
        this.#known.delete(path); // new work: pushed with no base
        continue;
      }
      if (file) await removeFile(this.#o.root, path);
      this.#known.set(path, { ...k, deleted: true, rev: head });
      dropped += 1;
    }
    return dropped;
  }

  /**
   * Plan under the lock (scan, hash, revert read-only areas, ask what content the server lacks),
   * upload outside it (a large upload never holds up a run's pull), commit under it again —
   * dropping any change whose path a pull touched meanwhile (the next push recomputes it).
   */
  async #push(): Promise<PushStats> {
    const stats = { changes: 0, uploaded: 0, bytes: 0, conflicts: 0, rejected: 0 };
    const plan = await this.#serial(() => this.#plan());
    stats.changes = plan.changes.length;
    if (plan.changes.length === 0) return stats;
    const failed = new Set<string>();
    await parallel(plan.uploads, Math.min(4, this.#o.concurrency), async (c) => {
      if (c.op !== "put") return;
      try {
        await this.#o.client.upload(c.sha256, await openForUpload(this.#o.root, c.path), c.size);
        stats.uploaded += 1;
        stats.bytes += c.size;
      } catch (error) {
        failed.add(c.sha256);
        // 413: too large for good (until the file changes). 507 (budget full) is retried next
        // push: collection frees room.
        if (error instanceof SyncHttpError && error.status === 413 && c.local) {
          this.#refused.set(c.path, c.local);
          stats.rejected += 1;
        } else {
          // 409: content being collected, 422 or a body-length error: the file changed while
          // uploading; anything else: logged. This file waits for the next push, the rest goes on.
          this.#warn("workspace upload failed for one file", error);
        }
      }
    });
    const ready = plan.changes.filter((c) => c.op === "delete" || !failed.has(c.sha256));
    const committed = await this.#serial(() => this.#commit(ready));
    return {
      ...stats,
      conflicts: committed.conflicts,
      rejected: stats.rejected + committed.rejected,
    };
  }

  async #plan(): Promise<PushPlan> {
    const scan = await scanWorkspace(this.#o.root, {
      skipDirs: this.#o.skipDirs,
      maxFiles: this.#o.maxFiles,
    });
    const changes: PlannedChange[] = [];
    let reverted = false;
    for (const [path, file] of scan.files) {
      const k = this.#known.get(path);
      if (isServerOwnedPath(path)) {
        // Read-only area: undo local edits and drop files the server never wrote.
        if (!k || k.deleted) {
          await this.#evict(path);
          reverted = true;
        } else if (!sameAs(file, k)) {
          await this.#download(path).catch((error: unknown) => this.#warn("revert failed", error));
          reverted = true;
        }
        continue;
      }
      if (k && !k.deleted && sameAs(file, k) && file.executable === k.executable) continue;
      const refused = this.#refused.get(path);
      if (refused && sameAs(file, refused)) continue;
      const hashed = await hashFile(this.#o.root, path);
      if (!hashed) {
        await this.#noteUnreadable(path);
        continue; // changing right now, or unreadable: next time
      }
      if (hashed.size !== file.size) continue; // changing right now: next time
      changes.push({
        op: "put",
        path,
        base_rev: k?.rev ?? null,
        sha256: hashed.sha256,
        size: hashed.size,
        mtime_ms: file.mtimeMs,
        executable: file.executable,
        local: file,
      });
    }
    const unsure = (path: string) =>
      scan.truncated || scan.incomplete.some((d) => d === "" || path.startsWith(`${d}/`));
    for (const [path, k] of this.#known) {
      if (k.deleted || scan.files.has(path) || isExcludedPath(path) || unsure(path)) continue;
      if (this.#retry.has(path)) continue; // not restored yet: never a deletion
      if (path.split("/").some((part) => this.#o.skipDirs.has(part))) continue;
      if (isServerOwnedPath(path)) {
        await this.#download(path).catch((error: unknown) => this.#warn("revert failed", error));
        reverted = true;
        continue;
      }
      changes.push({ op: "delete", path, base_rev: k.rev });
    }
    if (reverted) await lockServerOwned(this.#o.root, WORKSPACE_SERVER_OWNED_PREFIXES);
    const hashes = [...new Set(changes.flatMap((c) => (c.op === "put" ? [c.sha256] : [])))];
    const missing = new Set<string>();
    for (let i = 0; i < hashes.length; i += MISSING_BATCH) {
      for (const h of await this.#o.client.missing(hashes.slice(i, i + MISSING_BATCH))) {
        missing.add(h);
      }
    }
    const seen = new Set<string>();
    const uploads = changes.filter((c) => {
      if (c.op !== "put" || !missing.has(c.sha256) || seen.has(c.sha256)) return false;
      seen.add(c.sha256);
      return true;
    });
    return { changes, uploads };
  }

  async #commit(
    planned: readonly PlannedChange[],
  ): Promise<{ conflicts: number; rejected: number }> {
    let conflicts = 0;
    let rejected = 0;
    // A pull may have moved a path since the plan: its base is stale, recompute next time.
    const ready = planned.filter((c) => (this.#known.get(c.path)?.rev ?? null) === c.base_rev);
    for (let i = 0; i < ready.length; i += COMMIT_BATCH) {
      const batch = ready.slice(i, i + COMMIT_BATCH);
      const out = await this.#o.client.commit(batch.map(({ local: _l, ...change }) => change));
      for (const [j, result] of out.results.entries()) {
        const change = batch[j];
        if (!change) continue;
        // One path's local trouble (a name, a link) never abandons the other results.
        try {
          await this.#applyResult(
            change,
            result,
            () => (conflicts += 1),
            () => (rejected += 1),
          );
        } catch (error) {
          this.#known.delete(change.path); // recomputed from scratch on the next push
          this.#warn("could not apply a commit result for one file", error);
        }
      }
    }
    return { conflicts, rejected };
  }

  async #applyResult(
    change: PlannedChange,
    result: WorkspaceChangeResult,
    conflict: () => void,
    reject: () => void,
  ): Promise<void> {
    if (result.status === "applied") {
      this.#known.set(result.path, known(result.entry));
      this.#refused.delete(result.path);
    } else if (result.status === "noop") {
      this.#known.delete(result.path);
    } else if (result.status === "conflict") {
      conflict();
      await this.#resolveConflict(change, result.current);
    } else {
      reject();
      if (result.code !== "missing_blob" && change.local) {
        this.#refused.set(result.path, change.local);
      }
      this.#o.logger.warn({ code: result.code }, "workspace change refused by the server");
    }
  }

  /** The server's newer version keeps the path; the local edit becomes a conflict copy. */
  async #resolveConflict(
    change: WorkspaceChange,
    current: WorkspaceEntry | undefined,
  ): Promise<void> {
    if (current === undefined || current.deleted) {
      // Deleted meanwhile: our modification wins on top of the tombstone (next push).
      if (current) this.#known.set(change.path, known(current));
      else this.#known.delete(change.path);
      return;
    }
    if (change.op === "put") {
      // Our own earlier write whose answer was lost, or identical content: adopt it.
      const local = await hashFile(this.#o.root, change.path);
      if (local !== undefined && local.sha256 === current.sha256) {
        const file = await statLocal(this.#o.root, change.path);
        this.#known.set(
          change.path,
          known({ ...current, mtime_ms: file?.mtimeMs ?? current.mtime_ms }),
        );
        return;
      }
      await this.#conflictCopy(change.path);
    }
    await this.#downloadSafely(current);
  }
}
