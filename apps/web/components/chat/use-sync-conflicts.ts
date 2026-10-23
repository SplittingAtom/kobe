"use client";

/**
 * The thread's open workspace sync conflicts (KOBE-492, `GET /v1/threads/{id}/sync-conflicts`).
 * Read when the thread opens and after each run ends: the sandbox pushes a run's files shortly
 * after it ends and finds a conflict then, so the list is read again a few times, backing off
 * (bounded, like KOBE-488's file badges). Anyone but the thread's owner gets 404: no notices.
 */
import { useCallback, useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import type { SyncConflictView } from "../../lib/files/sync-conflicts";
import { kobeExtrasOf, useChatSession } from "./kobe-runtime";

/** Re-reads after a run ends (ms after the previous read). */
export const SYNC_CONFLICTS_RETRY_MS: readonly number[] = [2_500, 5_000, 10_000];
const NONE: readonly SyncConflictView[] = [];

interface Listed {
  readonly threadId: string;
  readonly conflicts: readonly SyncConflictView[];
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The last ended run of the thread on screen ("" while none ended on this page). */
function useEndedRun(threadId: string | undefined): string {
  return useAuiState((s) => {
    const extras = kobeExtrasOf(s);
    const live = extras?.state.live;
    if (!live || threadId === undefined || extras?.state.threadId !== threadId) return "";
    return live.terminal === undefined ? "" : live.runId;
  });
}

export interface SyncConflicts {
  readonly conflicts: readonly SyncConflictView[];
  /** Settles one: hidden at once, then told to the server (shown again if that fails). */
  settle(id: string, action: "resolved" | "dismissed"): Promise<boolean>;
}

export function useSyncConflicts(threadId: string | undefined): SyncConflicts {
  const session = useChatSession();
  const ended = useEndedRun(threadId);
  const [list, setList] = useState<Listed | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (threadId === undefined) return;
    let current = true;
    const read = async () => {
      for (const delay of ended === "" ? [0] : [0, ...SYNC_CONFLICTS_RETRY_MS]) {
        if (delay > 0) await wait(delay);
        if (!current) return;
        const res = await session.api.syncConflicts(threadId);
        if (!current) return;
        setList({ threadId, conflicts: res.ok ? res.data : NONE });
        if (!res.ok) return;
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [session, threadId, ended]);

  const settle = useCallback(
    async (id: string, action: "resolved" | "dismissed") => {
      if (threadId === undefined) return false;
      setHidden((h) => new Set([...h, id]));
      const res = await session.api.settleSyncConflict(threadId, id, action);
      if (!res.ok) {
        setHidden((h) => new Set([...h].filter((x) => x !== id)));
        return false;
      }
      return true;
    },
    [session, threadId],
  );

  const conflicts =
    list !== null && list.threadId === threadId
      ? list.conflicts.filter((c) => !hidden.has(c.id))
      : NONE;
  return { conflicts, settle };
}
