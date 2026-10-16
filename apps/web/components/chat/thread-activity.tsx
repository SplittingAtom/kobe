"use client";

import { useAuiState } from "@assistant-ui/react";
import { useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  ACTIVITY_POLL_MS,
  readActivity,
  stripTitlePrefix,
  titlePrefix,
  type ThreadActivity,
  type ThreadActivityStore,
} from "../../lib/chat/thread-activity";
import { StatusDot } from "../ui/status";
import { ChatSessionContext } from "./kobe-runtime";
import styles from "./chat.module.css";

const EMPTY: ReadonlyMap<string, ThreadActivity> = new Map();
const noopSubscribe = () => () => {};

/** The live activities of the threads this tab holds open (empty outside a chat session). */
function useLiveActivities(store: ThreadActivityStore | undefined) {
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.snapshot ?? (() => EMPTY),
    () => EMPTY,
  );
}

/** One rail row's activity: live while this tab holds it, else as the thread list said. */
export function useRowActivity(): ThreadActivity {
  const store = useContext(ChatSessionContext)?.activity;
  const live = useLiveActivities(store);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const listed = useAuiState((s) => readActivity(s.threadListItem.custom));
  return (remoteId === undefined ? undefined : live.get(remoteId)) ?? listed;
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
}: {
  readonly activity: ThreadActivity;
  readonly id: string;
}) {
  if (activity === "idle") return null;
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
 * Keeps the rail's activity current and puts it in the tab title (KOBE-301). The list is read
 * again when a thread that ran is let go (its summary predates the run's end) and every
 * `pollMs` while a thread this tab does not hold is running or waiting: the server's thread
 * status and `pending_approval` are the only source for those. No poll while all is idle.
 */
export function ThreadActivityWatch({
  reload,
  pollMs = ACTIVITY_POLL_MS,
}: {
  readonly reload: () => void;
  readonly pollMs?: number | undefined;
}) {
  const store = useContext(ChatSessionContext)?.activity;
  const live = useLiveActivities(store);
  const items = useAuiState((s) => s.threads.threadItems);
  const activities = useMemo(
    () =>
      items.map((i) => {
        const held = i.remoteId === undefined ? undefined : live.get(i.remoteId);
        return { held: held !== undefined, activity: held ?? readActivity(i.custom) };
      }),
    [items, live],
  );
  const unheldActive = activities.some((a) => !a.held && a.activity !== "idle");

  useEffect(() => store?.onStale(() => reload()), [store, reload]);
  useEffect(() => {
    if (!unheldActive) return;
    const timer = setInterval(reload, pollMs);
    return () => clearInterval(timer);
  }, [unheldActive, reload, pollMs]);

  useTabTitle(titlePrefix([...activities.map((a) => a.activity), ...live.values()]));
  return null;
}
