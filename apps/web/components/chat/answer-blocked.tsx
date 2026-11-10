"use client";

import { useAuiState } from "@assistant-ui/react";
import type { ThreadEgressBlockedResponse } from "@kobe/protocol";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { blockedByPrompt, type BlockedNotice } from "../../lib/chat/egress-blocked";
import type { KobeMessageMeta } from "../../lib/chat/tree";
import { useKobeExtras } from "./kobe-runtime";
import { NoticeSlot } from "./slots";

const NONE: readonly BlockedNotice[] = [];
const BlockedContext = createContext<ReadonlyMap<string, readonly BlockedNotice[]>>(new Map());

/**
 * The open thread's stored blocked-egress notices (KOBE-605, `GET /v1/threads/{id}/egress-blocked`),
 * read when the thread opens, when another run is followed and when the followed run ends, so each
 * answer keeps its cards after its run and after a reload. The followed run's own cards stay with
 * the run notices (`run-notices.tsx`). A failed read keeps the last good one.
 */
export function ThreadBlockedProvider({ children }: { readonly children: ReactNode }) {
  const extras = useKobeExtras();
  const controller = extras?.controller;
  const threadId = extras?.state.threadId ?? null;
  const live = extras?.state.live;
  const liveRunId = live?.runId;
  const ended = live?.terminal !== undefined;
  const [read, setRead] = useState<{
    readonly threadId: string;
    readonly data: ThreadEgressBlockedResponse;
  } | null>(null);
  useEffect(() => {
    if (!controller || threadId === null) return;
    let current = true;
    void controller.threadEgressBlocked()?.then((data) => {
      if (current && data !== null) setRead({ threadId, data });
    });
    return () => {
      current = false;
    };
  }, [controller, threadId, liveRunId, ended]);
  const data = read !== null && read.threadId === threadId ? read.data : null;
  const value = useMemo(() => blockedByPrompt(data, liveRunId), [data, liveRunId]);
  return <BlockedContext.Provider value={value}>{children}</BlockedContext.Provider>;
}

/** This answer's blocked cards from runs that are no longer followed (closable, KOBE-468). */
export function AnswerBlockedNotices() {
  const meta = useAuiState((s) => s.message.metadata.custom as KobeMessageMeta | undefined);
  const byPrompt = useContext(BlockedContext);
  const prompt = meta?.kind === "assistant" ? meta.promptEntryId : undefined;
  const notices = prompt === undefined ? NONE : (byPrompt.get(prompt) ?? NONE);
  if (notices.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-2">
      {notices.map((notice) => (
        <NoticeSlot key={`${notice.run_id}:${notice.payload.domain}`} notice={notice} />
      ))}
    </div>
  );
}
