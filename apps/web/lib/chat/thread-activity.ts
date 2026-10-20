/**
 * What each thread is doing, for the rail's dots and the tab title (KOBE-301): a run going
 * (`running`, green) or an approval waiting for the member (`approval`, amber). Only the member's
 * own runs count: a teammate's run on a thread shared with them is not theirs to watch.
 *
 * Three sources, the first that knows wins:
 * - A thread this tab holds open (`ChatSession.acquire`) follows its controller: its run stream
 *   says when a run starts, asks for an approval and ends.
 * - `GET /v1/threads/activity` (one cheap query), polled every {@link ACTIVITY_POLL_MS} while the
 *   tab is visible, on focus, when the tab shows again and when a held thread that ran is let go.
 *   It also sees runs this tab never started (a schedule, another device). Unlisted = idle.
 * - Before its first answer: the thread list's summaries (`status`, `pending_approval`).
 */
import type { ThreadState } from "./thread-state";
import { isThreadRunning } from "./thread-state";
import type { ThreadSummary } from "./types";

export type ThreadActivity = "idle" | "running" | "approval";

/** How often the activity is read while the tab is visible. */
export const ACTIVITY_POLL_MS = 15_000;

/** A thread from the list: an approval waiting for the caller wins over a plain run. */
export function activityOfSummary(summary: ThreadSummary): ThreadActivity {
  if (summary.deletedAt !== null || summary.readOnly === true) return "idle";
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
  if (state.summary?.deletedAt != null || state.summary?.readOnly === true) return "idle";
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
 * What the store knows: held threads live, the last activity read (null before one), and the
 * threads with new activity the member has not seen (KOBE-453): a run that ended, or an approval
 * that went, while the thread was not on screen; unread until the member opens it.
 */
export interface ActivitySnapshot {
  readonly unread: ReadonlySet<string>;
  readonly live: ReadonlyMap<string, ThreadActivity>;
  readonly polled: ReadonlyMap<string, ThreadActivity> | null;
}

/** A thread's activity from a snapshot; undefined when neither source knows yet. */
export function activityIn(
  snapshot: ActivitySnapshot,
  threadId: string,
): ThreadActivity | undefined {
  return (
    snapshot.live.get(threadId) ??
    (snapshot.polled === null ? undefined : (snapshot.polled.get(threadId) ?? "idle"))
  );
}

/**
 * The activity of the threads this tab holds open, live, and the last `GET /v1/threads/activity`
 * answer. Immutable snapshots (a new object per change) for `useSyncExternalStore`. A thread let
 * go after it saw a run is reported `stale`: the activity is read again at once.
 */
export class ThreadActivityStore {
  #snapshot: ActivitySnapshot = { live: new Map(), polled: null, unread: new Set() };
  #onScreen: string | null = null;
  #sawRun: ReadonlySet<string> = new Set();
  readonly #listeners = new Set<() => void>();
  readonly #staleListeners = new Set<(threadId: string) => void>();

  readonly snapshot = (): ActivitySnapshot => this.#snapshot;

  get(threadId: string): ThreadActivity | undefined {
    return activityIn(this.#snapshot, threadId);
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
    const { live } = this.#snapshot;
    if (live.get(threadId) === activity) return;
    const next = new Map(live);
    if (activity === undefined) next.delete(threadId);
    else next.set(threadId, activity);
    this.#update({ ...this.#snapshot, live: next });
  }

  /** The server's answer: threads not in it are idle. */
  setPolled(polled: ReadonlyMap<string, ThreadActivity>): void {
    const old = this.#snapshot.polled;
    const same =
      old !== null && old.size === polled.size && [...polled].every(([id, a]) => old.get(id) === a);
    if (!same) this.#update({ ...this.#snapshot, polled: new Map(polled) });
  }

  /** The tab no longer holds the thread: the polled (or listed) value stands again. */
  release(threadId: string): void {
    const sawRun = this.#sawRun.has(threadId);
    if (sawRun) this.#sawRun = new Set([...this.#sawRun].filter((id) => id !== threadId));
    this.set(threadId, undefined);
    if (sawRun) for (const listener of this.#staleListeners) listener(threadId);
  }

  clear(): void {
    this.#sawRun = new Set();
    this.#update({ live: new Map(), polled: null, unread: new Set() });
  }

  /** The thread on screen (null: a new conversation): seen, so never unread. */
  setOnScreen(threadId: string | null): void {
    this.#onScreen = threadId;
    if (threadId !== null && this.#snapshot.unread.has(threadId)) {
      const unread = new Set(this.#snapshot.unread);
      unread.delete(threadId);
      this.#update({ ...this.#snapshot, unread });
    }
  }

  #update(next: ActivitySnapshot): void {
    next = this.#withUnread(this.#snapshot, next);
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }

  /** A thread that ran or waited and is now idle, off screen, has new activity. */
  #withUnread(prev: ActivitySnapshot, next: ActivitySnapshot): ActivitySnapshot {
    const ids = new Set([...prev.live.keys(), ...(prev.polled?.keys() ?? [])]);
    let unread: Set<string> | null = null;
    for (const id of ids) {
      if (id === this.#onScreen || next.unread.has(id)) continue;
      const before = activityIn(prev, id);
      if (before === undefined || before === "idle" || activityIn(next, id) !== "idle") continue;
      unread ??= new Set(next.unread);
      unread.add(id);
    }
    return unread === null ? next : { ...next, unread };
  }
}
