/**
 * An open file tab notices outside changes to its file (KOBE-491): the agent's write or edit,
 * synced by the sandbox, or another save. The check is a metadata read (the parent folder's
 * listing carries each synced file's SHA-256, a database read with no file download and no audit
 * row), never a re-download; the watcher keeps at most one check in flight per tab and retries
 * only on a short, bounded schedule after a hint (a live write, a run's end, window focus).
 */
import type { FilesApi } from "./api";

export type VersionCheck =
  | { readonly kind: "version"; readonly sha256: string }
  /** No longer in the workspace (moved, renamed or deleted). */
  | { readonly kind: "gone" }
  /** Could not tell (an error, a file without a synced version, a folder too large to page). */
  | { readonly kind: "unknown" };

/** Listing pages read at most to find the file (5000 entries each, server side). */
const MAX_PAGES = 3;

/** Waits before checking again after a live write (ms; the sync lands after the run ends). */
export const WRITE_CHECK_MS: readonly number[] = [1_500, 3_000, 6_000, 12_000];
/** After a run ends: the post-run sync lands about 2 s later (ms, each after the previous). */
export const RUN_END_CHECK_MS: readonly number[] = [2_000, 3_000, 6_000];
/** Window focus checks at most this often (ms). */
export const FOCUS_MIN_INTERVAL_MS = 10_000;

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** The synced version of `path`, from its folder's listing. */
export async function fileVersion(
  api: FilesApi,
  path: string,
  signal?: AbortSignal,
): Promise<VersionCheck> {
  const folder = parentOf(path);
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (signal?.aborted) return { kind: "unknown" };
    const res = await api.list(folder, cursor, signal);
    if (!res.ok) return res.error.status === 404 ? { kind: "gone" } : { kind: "unknown" };
    const found = res.data.entries.find((e) => e.path === path && e.type === "file");
    if (found) {
      return found.sha256 === undefined
        ? { kind: "unknown" }
        : { kind: "version", sha256: found.sha256 };
    }
    if (!res.data.nextCursor) return { kind: "gone" };
    cursor = res.data.nextCursor;
  }
  return { kind: "unknown" };
}

/** Resolves after `ms`, or at once (clearing the timer) when `signal` aborts. */
function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/** What prompted a check: the thread's own agent (a live write, a run's end) or window focus. */
export type HintSource = "agent" | "focus";

export interface VersionWatchOptions {
  /** One check; `signal` aborts when the watch is disposed. */
  check(signal: AbortSignal): Promise<VersionCheck>;
  /** The version the tab shows now (undefined: nothing to compare, no check). */
  known(): string | undefined;
  /**
   * A different version, or the file is gone. `source`: what the hint that found it was (KOBE-496:
   * the agent's own write or run end in this thread may reload silently; focus may not).
   */
  onChange(result: Exclude<VersionCheck, { kind: "unknown" }>, source: HintSource): void;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A schedule ran to its end (found a change, or ran out of checks); not after settle or a newer hint. */
  onIdle?(source: HintSource): void;
}

/**
 * Checks on hints. Each hint replaces the previous schedule (`delays`: waits before each check,
 * the first usually 0); the schedule stops at the first change. Never two checks at once. A
 * one-shot hint (window focus) never cancels a pending schedule: while one runs it is skipped,
 * since that schedule checks anyway. `dispose` clears pending waits and aborts the check.
 */
export class VersionWatch {
  readonly #options: VersionWatchOptions;
  readonly #wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #abort = new AbortController();
  #generation = 0;
  /** The generation whose schedule is still running, if any. */
  #running: number | null = null;
  #runningSource: HintSource = "agent";
  #inFlight: Promise<VersionCheck> | null = null;

  constructor(options: VersionWatchOptions) {
    this.#options = options;
    this.#wait = options.wait ?? defaultWait;
  }

  hint(
    delays: readonly number[],
    options: { readonly oneShot?: boolean; readonly source?: HintSource } = {},
  ): void {
    if (this.#abort.signal.aborted) return;
    if (options.oneShot && this.#running !== null) return;
    this.#generation += 1;
    const generation = this.#generation;
    this.#running = generation;
    const source = options.source ?? (options.oneShot ? "focus" : "agent");
    this.#runningSource = source;
    void this.#run(generation, delays, source).finally(() => {
      if (this.#running !== generation) return;
      this.#running = null;
      if (!this.#abort.signal.aborted) this.#options.onIdle?.(source);
    });
  }

  /** What the schedule still checking was prompted by; null when none is. */
  get pending(): HintSource | null {
    return this.#running === null ? null : this.#runningSource;
  }

  /**
   * A newer version arrived another way (the change stream, KOBE-496): the pending schedule has
   * done its job and stops; a check in flight is dropped. Later hints start afresh.
   */
  settle(): void {
    this.#generation += 1;
    this.#running = null;
  }

  dispose(): void {
    this.#generation += 1;
    this.#running = null;
    this.#abort.abort();
  }

  #current(generation: number): boolean {
    return !this.#abort.signal.aborted && generation === this.#generation;
  }

  async #run(generation: number, delays: readonly number[], source: HintSource): Promise<void> {
    for (const delay of delays) {
      if (delay > 0) await this.#wait(delay, this.#abort.signal);
      if (this.#inFlight) await this.#inFlight.catch(() => undefined);
      if (!this.#current(generation)) return;
      const before = this.#options.known();
      if (before === undefined) return;
      const result = await this.#checkOnce();
      if (!this.#current(generation)) return;
      // The tab's own version moved meanwhile (its save, a re-read): this answer is stale.
      if (this.#options.known() !== before) return;
      if (result.kind === "gone") return this.#options.onChange(result, source);
      if (result.kind === "version" && result.sha256 !== before) {
        return this.#options.onChange(result, source);
      }
    }
  }

  async #checkOnce(): Promise<VersionCheck> {
    const pending = this.#options
      .check(this.#abort.signal)
      .catch((): VersionCheck => ({ kind: "unknown" }));
    this.#inFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.#inFlight === pending) this.#inFlight = null;
    }
  }
}

/** The smallest single replacement turning `before` into `after` (null: the same text). */
export function minimalChange(
  before: string,
  after: string,
): { readonly from: number; readonly to: number; readonly insert: string } | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) {
    end += 1;
  }
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}
