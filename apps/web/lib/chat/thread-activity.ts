/**
 * What each thread is doing, for the rail's dots and the tab title (KOBE-301): a run going
 * (`running`, green) or an approval waiting for the member (`approval`, amber).
 *
 * Two sources, live first:
 * - A thread this tab holds open (`ChatSession.acquire`) follows its controller: its run stream
 *   says when a run starts, asks for an approval and ends.
 * - Any other thread follows its summary in the thread list: `status` and `pending_approval`
 *   (computed by the server for the caller). The list is read again when a held thread that saw a
 *   run is let go, and every {@link ACTIVITY_POLL_MS} while a listed thread is active.
 */
import type { ThreadState } from "./thread-state";
import { isThreadRunning } from "./thread-state";
import type { ThreadSummary } from "./types";

export type ThreadActivity = "idle" | "running" | "approval";

/** How often the thread list is read again while a thread not open here is active. */
export const ACTIVITY_POLL_MS = 15_000;

/** A thread from the list: an approval waiting for the caller wins over a plain run. */
export function activityOfSummary(summary: ThreadSummary): ThreadActivity {
  if (summary.deletedAt !== null) return "idle";
  if (summary.pendingApproval === true) return "approval";
  return summary.status === "running" ? "running" : "idle";
}

/** Approvals the open thread's run waits on, asked of the viewer and not answered yet. */
export function waitingApprovals(state: ThreadState): number {
  if (state.summary?.readOnly === true || !isThreadRunning(state)) return 0;
  return Object.values(state.live?.tools ?? {}).filter(
    (t) => t.approvalRequested !== undefined && t.approvalResolved === undefined,
  ).length;
}

/** An open thread, from its live state; undefined until it is read (the list's value stands). */
export function activityOfState(state: ThreadState): ThreadActivity | undefined {
  if (state.threadId === null || state.phase !== "ready") return undefined;
  if (state.summary?.deletedAt != null) return "idle";
  if (waitingApprovals(state) > 0) return "approval";
  return isThreadRunning(state) ? "running" : "idle";
}

/** The rail item's `custom.activity`, read back defensively. */
export function readActivity(custom: unknown): ThreadActivity {
  const value = (custom as { activity?: unknown } | null | undefined)?.activity;
  return value === "running" || value === "approval" ? value : "idle";
}

/** The tab title's prefix for the activities shown: an approval first, then a run. */
export function titlePrefix(activities: Iterable<ThreadActivity>): string {
  let running = false;
  for (const a of activities) {
    if (a === "approval") return TITLE_PREFIX.approval;
    if (a === "running") running = true;
  }
  return running ? TITLE_PREFIX.running : "";
}

export const TITLE_PREFIX = { running: "● ", approval: "(!) " } as const;

/** The title without a prefix this module added. */
export function stripTitlePrefix(title: string): string {
  for (const prefix of Object.values(TITLE_PREFIX)) {
    if (title.startsWith(prefix)) return title.slice(prefix.length);
  }
  return title;
}

/**
 * The live activity of the threads this tab holds open. Immutable snapshots (a new map per
 * change) for `useSyncExternalStore`. A thread let go after it saw a run is reported `stale`: its
 * summary in the list predates the run's end, so the list must be read again.
 */
export class ThreadActivityStore {
  #live: ReadonlyMap<string, ThreadActivity> = new Map();
  #sawRun: ReadonlySet<string> = new Set();
  readonly #listeners = new Set<() => void>();
  readonly #staleListeners = new Set<(threadId: string) => void>();

  readonly snapshot = (): ReadonlyMap<string, ThreadActivity> => this.#live;

  get(threadId: string): ThreadActivity | undefined {
    return this.#live.get(threadId);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  onStale(listener: (threadId: string) => void): () => void {
    this.#staleListeners.add(listener);
    return () => this.#staleListeners.delete(listener);
  }

  set(threadId: string, activity: ThreadActivity | undefined): void {
    if (activity !== undefined && activity !== "idle" && !this.#sawRun.has(threadId)) {
      this.#sawRun = new Set([...this.#sawRun, threadId]);
    }
    if (this.#live.get(threadId) === activity) return;
    const next = new Map(this.#live);
    if (activity === undefined) next.delete(threadId);
    else next.set(threadId, activity);
    this.#live = next;
    this.#emit();
  }

  /** The tab no longer holds the thread: the list's value stands again. */
  release(threadId: string): void {
    const sawRun = this.#sawRun.has(threadId);
    if (sawRun) this.#sawRun = new Set([...this.#sawRun].filter((id) => id !== threadId));
    this.set(threadId, undefined);
    if (sawRun) for (const listener of this.#staleListeners) listener(threadId);
  }

  clear(): void {
    this.#live = new Map();
    this.#sawRun = new Set();
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
