"use client";

import { useEffect, useRef } from "react";
import { browserEventSource, type EventSourceFactory } from "../chat/stream";

/**
 * Live progress of open evals (KOBE-328): the eval SSE stream KOBE-325 serves
 * (`GET /v1/skill-evals/{id}/events`: `skill.eval.progress` per execution done, then
 * `skill.eval.completed`) asks for a fresh read on every event. If a stream errors, polling every
 * {@link EVAL_POLL_MS} takes over (skipped while the tab is hidden), and stops after
 * {@link MAX_POLL_FAILURES} failed reads in a row.
 */
export const EVAL_POLL_MS = 2_000;
export const MAX_POLL_FAILURES = 5;

export const evalEventsUrl = (id: string) => `/v1/skill-evals/${encodeURIComponent(id)}/events`;

export function useLiveEval(
  openIds: readonly string[],
  /** Reads again; resolves whether the read worked. */
  reload: () => Promise<boolean>,
  eventSource: EventSourceFactory = browserEventSource,
): void {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const key = [...openIds].sort().join(",");
  useEffect(() => {
    if (key === "") return;
    let poll: ReturnType<typeof setInterval> | undefined;
    let failures = 0;
    const read = async () => {
      const ok = await reloadRef.current();
      failures = ok ? 0 : failures + 1;
      if (failures >= MAX_POLL_FAILURES && poll) {
        clearInterval(poll);
        poll = undefined;
      }
    };
    const fallBack = () => {
      if (poll) return;
      poll = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        void read();
      }, EVAL_POLL_MS);
    };
    const sources = key.split(",").flatMap((id) => {
      let source;
      try {
        source = eventSource(evalEventsUrl(id));
      } catch {
        // No EventSource here (an old browser, a test DOM): poll instead.
        fallBack();
        return [];
      }
      source.addEventListener("skill.eval.progress", () => void read());
      source.addEventListener("skill.eval.completed", () => {
        source.close();
        void read();
      });
      source.onerror = () => {
        source.close();
        fallBack();
      };
      return [source];
    });
    return () => {
      for (const s of sources) s.close();
      if (poll) clearInterval(poll);
    };
  }, [key, eventSource]);
}
