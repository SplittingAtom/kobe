"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listAppResults, type AppResultView } from "../../lib/apps/app-results";
import { releaseSlot, takeSlot } from "../../lib/apps/live-slots";
import { approvalKey, runToolKey } from "../../lib/chat/markers";
import { useChatSession, useKobeExtras } from "../chat/kobe-runtime";

/**
 * MCP Apps in the thread on screen (KOBE-438, spec MA10): the server's per-viewer list of the
 * thread's app results, read when the thread opens, when a run ends and when a live tool result
 * carries an `app` marker; and the thread's live-frame slots (at most 3, T13).
 */
export interface ThreadApps {
  readonly threadId: string | null;
  readonly teamId: string;
  /** By prompt entry and tool call (`approvalKey`); the live run's by `runToolKey`. */
  readonly byPrompt: ReadonlyMap<string, AppResultView>;
  readonly byRun: ReadonlyMap<string, AppResultView>;
  /** Cards holding a live frame, least recently in view first. */
  readonly live: readonly string[];
  /** A slot for `key`; `force` (the member asked) retires the least recent frame. */
  take(key: string, force: boolean): void;
  release(key: string): void;
}

const NONE: ReadonlyMap<string, AppResultView> = new Map();
const ThreadAppsContext = createContext<ThreadApps | null>(null);

export function useThreadApps(): ThreadApps | null {
  return useContext(ThreadAppsContext);
}

/** The live run's app markers: a new one means the list is stale. */
function useLiveMarkers(): string {
  const tools = useKobeExtras()?.state.live?.tools;
  return useMemo(
    () =>
      tools
        ? Object.values(tools)
            .flatMap((t) => (t.result?.app ? [t.result.app.result_ref] : []))
            .join(",")
        : "",
    [tools],
  );
}

export function ThreadAppsProvider({ children }: { readonly children: ReactNode }) {
  const extras = useKobeExtras();
  const { teamId } = useChatSession();
  const threadId = extras?.state.threadId ?? null;
  const ended = extras?.state.live?.terminal ? extras.state.live.runId : null;
  const markers = useLiveMarkers();
  const [read, setRead] = useState<{
    threadId: string;
    results: readonly AppResultView[];
  } | null>(null);
  const [live, setLive] = useState<readonly string[]>([]);
  const latest = useRef(0);

  const load = useCallback(() => {
    if (threadId === null) return;
    latest.current += 1;
    const ticket = latest.current;
    void listAppResults(threadId, teamId).then((res) => {
      if (ticket !== latest.current) return;
      // Apps are a nicety on top of the text cards: a failed read leaves them as text.
      if (res.ok) setRead({ threadId, results: res.data.results });
    });
  }, [threadId, teamId]);
  useEffect(load, [load]);
  useEffect(() => {
    if (ended !== null || markers !== "") load();
  }, [ended, markers, load]);
  // Another thread: no frame of the last one stays live.
  useEffect(() => setLive([]), [threadId]);

  const results = read !== null && read.threadId === threadId ? read.results : null;
  const byPrompt = useMemo(
    () =>
      results === null
        ? NONE
        : new Map(
            results.flatMap((r) =>
              r.toolCallId === null ? [] : [[approvalKey(r.userEntryId, r.toolCallId), r] as const],
            ),
          ),
    [results],
  );
  const byRun = useMemo(
    () =>
      results === null
        ? NONE
        : new Map(
            results.flatMap((r) =>
              r.toolCallId === null || r.runId === null
                ? []
                : [[runToolKey(r.runId, r.toolCallId), r] as const],
            ),
          ),
    [results],
  );
  const take = useCallback((key: string, force: boolean) => {
    setLive((prev) => takeSlot(prev, key, force));
  }, []);
  const release = useCallback((key: string) => setLive((prev) => releaseSlot(prev, key)), []);
  const value = useMemo<ThreadApps>(
    () => ({ threadId, teamId, byPrompt, byRun, live, take, release }),
    [threadId, teamId, byPrompt, byRun, live, take, release],
  );
  return <ThreadAppsContext.Provider value={value}>{children}</ThreadAppsContext.Provider>;
}
