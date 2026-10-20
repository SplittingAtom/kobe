"use client";

import { useAuiState } from "@assistant-ui/react";
import { useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChatSession } from "../../lib/chat/session";
import {
  ACTIVITY_POLL_MS,
  activityIn,
  readActivity,
  stripTitlePrefix,
  TITLE_PREFIX,
  type ActivitySnapshot,
  type ThreadActivity,
  type ThreadActivityStore,
} from "../../lib/chat/thread-activity";
import { StatusDot } from "../ui/status";
import { ChatSessionContext } from "./kobe-runtime";
import styles from "./chat.module.css";

const EMPTY: ActivitySnapshot = { live: new Map(), polled: null, unread: new Set() };
const noopSubscribe = () => () => {};

/** Held threads live and the last activity read (empty outside a chat session). */
function useActivitySnapshot(store: ThreadActivityStore | undefined): ActivitySnapshot {
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.snapshot ?? (() => EMPTY),
    () => EMPTY,
  );
}

/** Whether a row's thread has new activity the member has not seen (KOBE-453). */
export function useRowUnread(): boolean {
  const snapshot = useActivitySnapshot(useContext(ChatSessionContext)?.activity);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  return remoteId !== undefined && snapshot.unread.has(remoteId);
}

/** One rail row's activity: live while this tab holds it, else as the server last said. */
export function useRowActivity(): ThreadActivity {
  const snapshot = useActivitySnapshot(useContext(ChatSessionContext)?.activity);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const listed = useAuiState((s) => readActivity(s.threadListItem.custom));
  return (remoteId === undefined ? undefined : activityIn(snapshot, remoteId)) ?? listed;
}

const ROW_LABEL: Record<ThreadActivity, string> = {
  idle: "",
  running: "Running",
  approval: "Waiting for your approval",
};

/**
 * The rail row's dot (KOBE-301): green and pulsing while a run goes, amber while an approval waits
 * for the member, with the state in words for screen readers: the row's button names `id` as its
 * description, so its name stays the title.
 */
export function ThreadActivityDot({
  activity,
  id,
  unread = false,
}: {
  readonly activity: ThreadActivity;
  readonly id: string;
  /** New activity not seen yet (KOBE-453): a quiet dot once nothing runs or waits. */
  readonly unread?: boolean;
}) {
  if (activity === "idle") {
    if (!unread) return null;
    return (
      <>
        <StatusDot tone="done" className={styles.railDot} />
        <span id={id} className={styles.visuallyHidden}>
          New activity
        </span>
      </>
    );
  }
  return (
    <>
      <StatusDot
        tone={activity === "running" ? "running" : "attention"}
        pulse={activity === "running"}
        className={styles.railDot}
      />
      <span id={id} className={styles.visuallyHidden}>
        {ROW_LABEL[activity]}
      </span>
    </>
  );
}

/**
 * The browser tab's title while the tab is hidden (KOBE-301): `● ` while a run goes and `(!) `
 * while an approval waits, in any of the member's threads. A visible tab never has a prefix; it
 * is taken off when the tab shows again, gets focus, or the state ends.
 */
export function useTabTitle(prefix: string): void {
  useEffect(() => {
    const apply = () => {
      const plain = stripTitlePrefix(document.title);
      const next = document.visibilityState === "hidden" && prefix !== "" ? prefix + plain : plain;
      if (next !== document.title) document.title = next;
    };
    apply();
    document.addEventListener("visibilitychange", apply);
    window.addEventListener("focus", apply);
    return () => {
      document.removeEventListener("visibilitychange", apply);
      window.removeEventListener("focus", apply);
      document.title = stripTitlePrefix(document.title);
    };
  }, [prefix]);
}

/**
 * Reads `GET /v1/threads/activity` into the session's store: at once, every `pollMs` while the tab
 * is visible, when it shows again or gets focus, and when a held thread that ran is let go. Older
 * answers never overwrite newer ones; a failed read keeps the last state.
 */
function useActivityPoll(session: ChatSession | null, pollMs: number): void {
  useEffect(() => {
    if (!session) return;
    let alive = true;
    let asked = 0;
    let answered = 0;
    const poll = () => {
      if (document.visibilityState === "hidden") return;
      const mine = ++asked;
      session.api.threadActivity().then(
        (res) => {
          if (!alive || mine < answered) return;
          answered = mine;
          if (res.ok) {
            session.activity.setPolled(
              new Map(res.data.threads.map((t) => [t.threadId, t.activity] as const)),
            );
          } else console.warn("threads: could not read the activity", res.error.code);
        },
        (err: unknown) => console.warn("threads: could not read the activity", err),
      );
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") poll();
    };
    poll();
    const timer = setInterval(poll, pollMs);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", poll);
    const offStale = session.activity.onStale(poll);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", poll);
      offStale();
    };
  }, [session, pollMs]);
}

/**
 * Keeps the rail's activity current and puts it in the tab title (KOBE-301): one cheap read of
 * the member's active threads (never the thread lists), merged into the rail without reloading
 * its pages.
 */
export function ThreadActivityWatch({
  pollMs = ACTIVITY_POLL_MS,
}: {
  readonly pollMs?: number | undefined;
}) {
  const session = useContext(ChatSessionContext);
  useActivityPoll(session, pollMs);
  const overall = useOverallActivity();
  useTabTitle(overall === "running" || overall === "approval" ? TITLE_PREFIX[overall] : "");
  return null;
}

/**
 * The member's threads at a glance (KOBE-301, KOBE-453): "approval" while any waits for the
 * member, else "running" while any runs, else "unread" while any has new activity the member has
 * not seen, else "idle". The tab title shows the first two. Live for the threads this tab holds, else as
 * the server last said, else as the list said. The tab title and the rail's Threads button show it.
 */
export type OverallActivity = ThreadActivity | "unread";

export function useOverallActivity(): OverallActivity {
  const snapshot = useActivitySnapshot(useContext(ChatSessionContext)?.activity);
  const items = useAuiState((s) => s.threads.threadItems);
  return useMemo(() => {
    // Every thread either source knows, each once: a held thread's live state wins over a
    // polled answer from before it changed.
    const listed = new Map(
      items.flatMap((i) =>
        i.remoteId === undefined ? [] : [[i.remoteId, readActivity(i.custom)]],
      ),
    );
    const ids = new Set([
      ...listed.keys(),
      ...snapshot.live.keys(),
      ...(snapshot.polled?.keys() ?? []),
    ]);
    const all = [...ids].map((id) => activityIn(snapshot, id) ?? listed.get(id) ?? "idle");
    if (all.includes("approval")) return "approval";
    if (all.includes("running")) return "running";
    return snapshot.unread.size > 0 ? "unread" : "idle";
  }, [items, snapshot]);
}

/** The words for the overall activity, for a badge on the Threads button. */
export const OVERALL_LABEL: Readonly<Record<Exclude<OverallActivity, "idle">, string>> = {
  running: "a conversation is running",
  approval: "a conversation is waiting for your approval",
  unread: "a conversation has new activity",
};
