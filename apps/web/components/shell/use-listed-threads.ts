"use client";

import { useAuiState } from "@assistant-ui/react";
import { useMemo } from "react";
import { placementCustom, type ListedThread } from "../../lib/chat/thread-groups";
import { useChatSession } from "../chat/kobe-runtime";

/**
 * assistant-ui's listed threads (not Trash) with their placement (`custom`), for the rail's groups
 * and the previous/next conversation keys (KOBE-225). A thread created since the last list read
 * has no `custom` yet: its seeded summary has it.
 */
export function useListedThreads(): readonly ListedThread[] {
  const session = useChatSession();
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const items = useAuiState((s) => s.threads.threadItems);
  return useMemo(() => {
    const seeded = (remoteId: string | undefined) => {
      const summary = remoteId === undefined ? null : session.peek(remoteId)?.getState().summary;
      return summary ? placementCustom(summary) : undefined;
    };
    const custom = new Map(items.map((i) => [i.id, i.custom ?? seeded(i.remoteId)]));
    return threadIds.map((id) => ({ id, custom: custom.get(id) }));
  }, [threadIds, items, session]);
}
