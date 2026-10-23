/**
 * Live changes to the files open in this page's tabs (KOBE-496): one EventSource on
 * `GET /v1/workspace/changes` for the whole open tab set (protocol `workspace-changes.ts`). Tabs
 * `watch` their path; a changed set re-opens the stream once, debounced. The latest change per
 * path is kept for the tabs to read. The browser reconnects by itself after a drop, and every
 * (re)connect starts with each path's current version (`file.state`), which the tabs compare with
 * what they show: the catch-up by version after a dropped stream or sleep. A stream the server
 * ended or refused is opened again after a bounded backoff (never a tight loop).
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
}

export class WorkspaceChangeFeed {
  readonly #teamId: string;
  readonly #factory: EventSourceFactory;
  readonly #debounceMs: number;
  readonly #reopenDelays: readonly number[];
  readonly #watchers = new Map<string, number>();
  readonly #latest = new Map<string, WorkspaceFileChange>();
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

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

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
    if (this.#disposed) return;
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
      const parsed = workspaceFileChangeSchema.safeParse(raw);
      if (!parsed.success || !this.#watchers.has(parsed.data.path)) return;
      const previous = this.#latest.get(parsed.data.path);
      // Never step back: a reconnect's state is at least as new as anything heard before it.
      if (previous !== undefined && previous.rev > parsed.data.rev) return;
      this.#attempt = 0;
      this.#latest.set(parsed.data.path, parsed.data);
      for (const listener of [...this.#listeners]) listener();
    };
    for (const type of WORKSPACE_CHANGE_EVENT_TYPES) source.addEventListener(type, onMessage);
    source.onerror = () => {
      if (this.#source !== source || source.readyState !== CLOSED) return;
      // Ended or refused by the server (not a network drop, which the browser retries itself).
      this.#close();
      const delay = this.#reopenDelays[Math.min(this.#attempt, this.#reopenDelays.length - 1)];
      this.#attempt += 1;
      this.#schedule(delay ?? 60_000);
    };
  }

  #close(): void {
    const source = this.#source;
    this.#source = undefined;
    this.#openPaths = [];
    source?.close();
  }
}
