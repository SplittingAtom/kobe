"use client";

import { useEffect, useRef, useState } from "react";
import { browserEventSource, type EventSourceFactory } from "../chat/stream";

/**
 * Live progress of open evals (KOBE-328): the eval SSE stream KOBE-325 serves
 * (`GET /v1/skill-evals/{id}/events`: `skill.eval.progress` per execution done, then
 * `skill.eval.completed`) asks for a fresh read on every event. A stream that errors is opened
 * again after {@link STREAM_RETRY_MS} (doubling, {@link STREAM_RETRIES} times; any event resets
 * it); only then does polling every {@link EVAL_POLL_MS} take over (skipped while the tab is
 * hidden). After {@link MAX_POLL_FAILURES} failed reads in a row polling stops and the hook says
 * so (`stalled`), so the page can tell the member.
 */
export const EVAL_POLL_MS = 2_000;
export const MAX_POLL_FAILURES = 5;
export const STREAM_RETRY_MS = 1_000;
export const STREAM_RETRIES = 3;

export const evalEventsUrl = (id: string) => `/v1/skill-evals/${encodeURIComponent(id)}/events`;

export function useLiveEval(
  openIds: readonly string[],
  /** Reads again; resolves whether the read worked. */
  reload: () => Promise<boolean>,
  eventSource: EventSourceFactory = browserEventSource,
): { readonly stalled: boolean } {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const [stalled, setStalled] = useState(false);
  const key = [...openIds].sort().join(",");
  useEffect(() => {
    setStalled(false);
    if (key === "") return;
    let poll: ReturnType<typeof setInterval> | undefined;
    let failures = 0;
    let done = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const sources = new Set<{ close(): void }>();
    const read = async () => {
      const ok = await reloadRef.current();
      if (done) return;
      failures = ok ? 0 : failures + 1;
      if (failures >= MAX_POLL_FAILURES && poll) {
        clearInterval(poll);
        poll = undefined;
        setStalled(true);
      }
    };
    const fallBack = () => {
      if (poll || done) return;
      poll = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        void read();
      }, EVAL_POLL_MS);
    };
    const open = (id: string, attempt: number) => {
      if (done) return;
      let source;
      try {
        source = eventSource(evalEventsUrl(id));
      } catch {
        // No EventSource here (an old browser, a test DOM): poll instead.
        fallBack();
        return;
      }
      sources.add(source);
      let retries = attempt;
      const alive = () => {
        retries = 0;
      };
      source.addEventListener("skill.eval.progress", () => {
        alive();
        void read();
      });
      source.addEventListener("skill.eval.completed", () => {
        alive();
        source.close();
        sources.delete(source);
        void read();
      });
      source.onerror = () => {
        source.close();
        sources.delete(source);
        if (done) return;
        if (retries >= STREAM_RETRIES) return fallBack();
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            open(id, retries + 1);
          },
          STREAM_RETRY_MS * 2 ** retries,
        );
        timers.add(timer);
      };
    };
    for (const id of key.split(",")) open(id, 0);
    return () => {
      done = true;
      for (const s of sources) s.close();
      for (const t of timers) clearTimeout(t);
      if (poll) clearInterval(poll);
    };
  }, [key, eventSource]);
  return { stalled };
}

/** What a page says when live progress gave up. */
export const STALLED_MESSAGE = "Progress isn't updating. Reload the page to see where the eval is.";
