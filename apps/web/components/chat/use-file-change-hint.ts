"use client";

/**
 * When an open file tab should check whether its file changed outside it (KOBE-491). There is no
 * workspace change push (the file tree re-lists only after a wake), so the hints are: the live
 * run's successful `write`/`edit` of this path (the signal KOBE-488's thread badges use), the end
 * of a run (the sandbox pushes a run's files about 2 s after it ends), and the window regaining
 * focus (at most every FOCUS_MIN_INTERVAL_MS). Each hint carries its bounded retry schedule; the
 * tab's `VersionWatch` keeps one check in flight.
 */
import { useEffect, useRef, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { isThreadRunning } from "../../lib/chat/thread-state";
import {
  FOCUS_MIN_INTERVAL_MS,
  RUN_END_CHECK_MS,
  WRITE_CHECK_MS,
} from "../../lib/files/outside-change";
import { kobeExtrasOf } from "./kobe-runtime";
import { liveWritePaths } from "./use-thread-files";

export interface ChangeHint {
  readonly seq: number;
  /** Waits before each check (ms). */
  readonly delays: readonly number[];
  /** Window focus: skipped while a write or run-end schedule is still pending. */
  readonly oneShot?: boolean | undefined;
}

/** `runId:count` of the live run's successful writes of `path`: changes on each new one. */
function useWritesOf(path: string, threadId: string | null): string {
  return useAuiState((s) => {
    const count = liveWritePaths(s, threadId ?? undefined).filter((p) => p === path).length;
    return count === 0 ? "" : `${kobeExtrasOf(s)?.state.live?.runId ?? ""}:${count}`;
  });
}

export function useFileChangeHint(path: string, threadId: string | null): ChangeHint | null {
  const [hint, setHint] = useState<ChangeHint | null>(null);
  const seq = useRef(0);
  const send = useRef((delays: readonly number[], oneShot = false) => {
    seq.current += 1;
    setHint({ seq: seq.current, delays, oneShot });
  });

  const writes = useWritesOf(path, threadId);
  useEffect(() => {
    if (writes !== "") send.current([0, ...WRITE_CHECK_MS]);
  }, [writes]);

  const running = useAuiState((s) => {
    const extras = kobeExtrasOf(s);
    return extras !== undefined && isThreadRunning(extras.state);
  });
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) send.current(RUN_END_CHECK_MS);
    wasRunning.current = running;
  }, [running]);

  useEffect(() => {
    let last = 0;
    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - last < FOCUS_MIN_INTERVAL_MS) return;
      last = now;
      send.current([0], true);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);
  return hint;
}
