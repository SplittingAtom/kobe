/**
 * Tells this browser's other tabs that a thread's place in the rail changed (CE19, KOBE-220:
 * pinned, archived, moved): they read their thread list again, and the thread itself when it is
 * open. Pin, archive and move are not run events, so no run stream carries them; the change is
 * the member's own, made in this browser, so a `BroadcastChannel` per team reaches every tab that
 * shows it. Another device sees it on its next list read (window focus, a new thread, a title).
 */

export interface ThreadListSync {
  /** Announces a change of `threadId` to the other tabs (never back to this one). */
  post(threadId: string): void;
  /** Called with the thread id of each change another tab announced. */
  subscribe(listener: (threadId: string) => void): () => void;
  close(): void;
}

interface Message {
  readonly origin: string;
  readonly threadId: string;
}

function isMessage(data: unknown): data is Message {
  const m = data as Partial<Message> | null;
  return typeof m?.origin === "string" && typeof m.threadId === "string";
}

/** The channel's name: one per team, so a tab on another team never reloads for it. */
export const syncChannelName = (teamId: string): string => `kobe-threads:${teamId}`;

/** The browser's channel for `teamId`, or undefined where `BroadcastChannel` is missing. */
export function browserThreadListSync(teamId: string): ThreadListSync | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  const channel = new BroadcastChannel(syncChannelName(teamId));
  // A channel never receives its own messages; the origin also guards against a second channel
  // of this tab (a remounted app).
  const origin = Math.random().toString(36).slice(2);
  const listeners = new Set<(threadId: string) => void>();
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (!isMessage(event.data) || event.data.origin === origin) return;
    for (const listener of listeners) listener(event.data.threadId);
  };
  return {
    post(threadId) {
      try {
        channel.postMessage({ origin, threadId } satisfies Message);
      } catch (err) {
        // A closed channel (the tab is going away): the other tabs read on their next focus.
        console.warn("threads: could not tell the other tabs", err);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      channel.close();
    },
  };
}
