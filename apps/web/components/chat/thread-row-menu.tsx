"use client";

import { useAuiState } from "@assistant-ui/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { threadReadOnly } from "../../lib/chat/thread-commands";
import type { ThreadController } from "../../lib/chat/thread-controller";
import type { ThreadState } from "../../lib/chat/thread-state";
import { ActionMenu, ROW_REVEAL } from "../ui/action-menu";
import { useChatSession } from "./kobe-runtime";
import { useThreadMenuBindings, type Notice } from "./use-thread-menu";

const NOTICE_MS = 2500;
const noopSubscribe = () => () => {};
const noState = () => undefined;

/** The thread's controller while the menu is open: its state decides what the menu offers. */
function useHeldThread(threadId: string | undefined, hold: boolean): ThreadState | undefined {
  const session = useChatSession();
  const [held, setHeld] = useState<ThreadController | null>(null);
  useEffect(() => {
    if (!hold || threadId === undefined) return;
    const controller = session.acquire(threadId);
    setHeld(controller);
    return () => {
      session.release(threadId, controller);
      setHeld(null);
    };
  }, [session, threadId, hold]);
  return useSyncExternalStore<ThreadState | undefined>(
    held?.subscribe ?? noopSubscribe,
    held?.getState ?? noState,
    held?.getState ?? noState,
  );
}

/**
 * A listed thread's ⋯ menu in the rail (KOBE-292): the thread's menu bindings
 * (`useThreadMenuBindings`: Copy, Regenerate (with), Pin, Move, Archive, Share, Delete), read
 * against the thread's state while the menu is open.
 */
export function ThreadRowMenu() {
  const threadId = useAuiState((s) => s.threadListItem.remoteId);
  const title = useAuiState((s) => s.threadListItem.title) || "Untitled conversation";
  const custom = useAuiState((s) => s.threadListItem.custom);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const state = useHeldThread(threadId, open);
  const readOnly = threadReadOnly(custom, state);
  const bindings = useThreadMenuBindings({
    threadId,
    title,
    custom,
    open,
    readOnly,
    state,
    notify: setNotice,
  });
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  if (threadId === undefined) return null;

  return (
    <>
      {notice && (
        <span aria-hidden className="text-muted-foreground shrink-0 text-xs">
          {notice.short}
        </span>
      )}
      <span role="status" className="sr-only">
        {notice?.full}
      </span>
      <ActionMenu
        trigger="thread-row-actions"
        label={`Actions for ${title}`}
        scope="thread-menu"
        bindings={bindings}
        onOpenChange={setOpen}
        className={ROW_REVEAL}
      />
    </>
  );
}
