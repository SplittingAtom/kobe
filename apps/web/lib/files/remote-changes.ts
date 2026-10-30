/**
 * Live changes to the files open in this page's tabs (KOBE-496): one EventSource on
 * `GET /v1/workspace/changes` for the whole open tab set (protocol `workspace-changes.ts`). Tabs
 * `watch` their path; a changed set re-opens the stream once, debounced. The latest change per
 * path is kept for the tabs to read. The browser reconnects by itself after a drop, and every
 * (re)connect starts with each path's current version (`file.state`), which the tabs compare with
 * what they show: the catch-up by version after a dropped stream or sleep. A stream the server
 * ended or refused is opened again after a bounded backoff (never a tight loop), unless `probe`
 * says the page's team is no longer the active one (another tab switched team): then it stops.
 * Paths past the server's limit get no live changes; `overflow` says so for their tabs.
 * A moved file's old path names its new one (`moved_to`, KOBE-516): open tabs follow it, and
 * `movedTo` keeps saying so after they did, so a late read of the old path is not a deletion.
 */
import {
  WORKSPACE_CHANGE_EVENT_TYPES,
  WORKSPACE_CHANGES_MAX_PATHS,
  workspaceFileChangeSchema,
  type WorkspaceFileChange,
} from "@kobe/protocol";
import "../security/zod-jitless";
import {
  browserEventSource,
  CLOSED,
  type EventSourceFactory,
  type EventSourceLike,
} from "../chat/stream";

/** Moves remembered after their tabs followed them (the oldest go first). */
export const MOVES_KEPT = 256;

/** Waits before a changed tab set re-opens the stream (ms). */
export const PATHS_DEBOUNCE_MS = 300;
/** Waits before opening a stream the server ended or refused again (ms, by attempt). */
export const REOPEN_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000];

export function workspaceChangesUrl(teamId: string, paths: readonly string[]): string {
  const q = new URLSearchParams({ team: teamId });
  for (const path of paths) q.append("path", path);
  return `/v1/workspace/changes?${q.toString()}`;
}

export interface WorkspaceChangeFeedOptions {
  readonly teamId: string;
  readonly eventSource?: EventSourceFactory | undefined;
  readonly debounceMs?: number;
  readonly reopenDelaysMs?: readonly number[];
  /**
   * Before re-opening a stream the server ended: false when it can never succeed again (the
   * active team changed), which stops the feed. EventSource cannot see the 409 itself.
   */
  readonly probe?: (() => Promise<boolean>) | undefined;
}

export class WorkspaceChangeFeed {
  readonly #teamId: string;
  readonly #factory: EventSourceFactory;
  readonly #debounceMs: number;
  readonly #reopenDelays: readonly number[];
  readonly #probe: (() => Promise<boolean>) | undefined;
  #stopped = false;
  readonly #watchers = new Map<string, number>();
  readonly #latest = new Map<string, WorkspaceFileChange>();
  readonly #moves = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  #source: EventSourceLike | undefined;
  #openPaths: readonly string[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  #disposed = false;

  constructor(options: WorkspaceChangeFeedOptions) {
    this.#teamId = options.teamId;
    this.#factory = options.eventSource ?? browserEventSource;
    this.#debounceMs = options.debounceMs ?? PATHS_DEBOUNCE_MS;
    this.#reopenDelays = options.reopenDelaysMs ?? REOPEN_DELAYS_MS;
    this.#probe = options.probe;
  }

  /** A tab shows `path`: it is in the stream's set until the returned function runs. */
  watch(path: string): () => void {
    this.#watchers.set(path, (this.#watchers.get(path) ?? 0) + 1);
    this.#schedule(this.#debounceMs);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.#watchers.get(path) ?? 1) - 1;
      if (n <= 0) {
        this.#watchers.delete(path);
        this.#latest.delete(path);
      } else this.#watchers.set(path, n);
      this.#schedule(this.#debounceMs);
    };
  }

  /** The latest change heard for `path` (its state at connect, or a newer revision). */
  get(path: string): WorkspaceFileChange | undefined {
    return this.#latest.get(path);
  }

  /** Where the stream last said `path` moved to (KOBE-516), until the path is written again. */
  movedTo(path: string): string | undefined {
    return this.#moves.get(path);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** `path` is open in a tab but past the stream's limit: its tab gets no live changes. */
  overflow(path: string): boolean {
    return this.#watchers.has(path) && !this.#wanted().includes(path);
  }

  /** The feed stopped for good (the page's team is no longer the active one). */
  get stopped(): boolean {
    return this.#stopped;
  }

  /** The paths the open stream follows (tests). */
  get streaming(): readonly string[] {
    return this.#source ? this.#openPaths : [];
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#close();
  }

  #schedule(ms: number): void {
    if (this.#disposed || this.#stopped) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#sync();
    }, ms);
  }

  /** The paths to follow: the watched ones, sorted, at most the server's limit. */
  #wanted(): string[] {
    return [...this.#watchers.keys()].sort().slice(0, WORKSPACE_CHANGES_MAX_PATHS);
  }

  #sync(): void {
    const wanted = this.#wanted();
    const same =
      this.#source !== undefined &&
      wanted.length === this.#openPaths.length &&
      wanted.every((p, i) => p === this.#openPaths[i]);
    if (same) return;
    this.#close();
    // The set changed: tabs past the limit (or back under it) re-read `overflow`.
    for (const listener of [...this.#listeners]) listener();
    if (wanted.length === 0) return;
    this.#open(wanted);
  }

  #open(paths: readonly string[]): void {
    const source = this.#factory(workspaceChangesUrl(this.#teamId, paths));
    this.#source = source;
    this.#openPaths = paths;
    const onMessage = (message: MessageEvent<string>) => {
      if (this.#source !== source) return;
      let raw: unknown;
      try {
        raw = JSON.parse(message.data);
      } catch {
        return;
      }
      const parsed = parseChange(raw);
      if (parsed === undefined || !this.#watchers.has(parsed.path)) return;
      // Every message counts, even at a lower revision: one connection sends them in order, and a
      // new connection's state is the truth now (a tombstone collected, revisions restarted).
      this.#attempt = 0;
      this.#latest.set(parsed.path, parsed);
      this.#remember(parsed);
      for (const listener of [...this.#listeners]) listener();
    };
    for (const type of WORKSPACE_CHANGE_EVENT_TYPES) source.addEventListener(type, onMessage);
    source.onerror = () => {
      if (this.#source !== source || source.readyState !== CLOSED) return;
      // Ended or refused by the server (not a network drop, which the browser retries itself).
      this.#close();
      const delay = this.#reopenDelays[Math.min(this.#attempt, this.#reopenDelays.length - 1)];
      this.#attempt += 1;
      const probe = this.#probe;
      if (!probe) return this.#schedule(delay ?? 60_000);
      void probe().then(
        (retry) => {
          if (retry) this.#schedule(delay ?? 60_000);
          else this.#stop();
        },
        () => this.#schedule(delay ?? 60_000),
      );
    };
  }

  #remember(change: WorkspaceFileChange): void {
    this.#moves.delete(change.path);
    if (change.moved_to == null) return;
    this.#moves.set(change.path, change.moved_to);
    if (this.#moves.size > MOVES_KEPT) {
      const oldest = this.#moves.keys().next().value;
      if (oldest !== undefined) this.#moves.delete(oldest);
    }
  }

  #stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#close();
    for (const listener of [...this.#listeners]) listener();
  }

  #close(): void {
    const source = this.#source;
    this.#source = undefined;
    this.#openPaths = [];
    source?.close();
  }
}

/**
 * A change as the contract has it; one whose only fault is its actor's name keeps the change with
 * no name (the badge then says who in general terms) instead of being dropped.
 */
function parseChange(raw: unknown): WorkspaceFileChange | undefined {
  const parsed = workspaceFileChangeSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const actor = (raw as { actor?: unknown } | null)?.actor;
  if (typeof actor !== "object" || actor === null) return undefined;
  const retry = workspaceFileChangeSchema.safeParse({
    ...(raw as object),
    actor: { ...(actor as object), name: null },
  });
  return retry.success ? retry.data : undefined;
}
