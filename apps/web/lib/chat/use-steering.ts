"use client";

import { useEffect, useRef, useState } from "react";
import type { BudgetStatus } from "../admin/api/budgets";
import type { ApiResult } from "../api/client";

/** At most one budget read per this long on tool results (the run start always reads). */
export const BUDGET_RECHECK_MS = 5_000;

/**
 * "Finishing on budget" (CE10) has no live event: the server sets the run's budget stop quietly
 * and sends `run.budget_stopped` only at the end. So the panel reads the member's budget status
 * when a run starts and again on tool results, at most once per {@link BUDGET_RECHECK_MS}, and
 * treats an exhausted budget during a run as "finishing on budget". (A live event would be
 * cleaner; follow-up noted in the KOBE-206 ledger.)
 */
export function useBudgetFinishing(
  read: (() => Promise<ApiResult<BudgetStatus>>) | undefined,
  runId: string | undefined,
  toolResults: number,
): boolean {
  const [exhausted, setExhausted] = useState<{ runId: string; value: boolean } | null>(null);
  const run = useRef<string | undefined>(undefined);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!read || runId === undefined) return;
    const check = () => {
      timer.current = undefined;
      last.current = Date.now();
      void read().then((res) => {
        if (run.current === runId && res.ok) {
          setExhausted({ runId, value: res.data.state === "exhausted" });
        }
      });
    };
    if (run.current !== runId) {
      run.current = runId;
      clearTimeout(timer.current);
      check();
    } else if (toolResults > 0 && timer.current === undefined) {
      timer.current = setTimeout(check, Math.max(0, last.current + BUDGET_RECHECK_MS - Date.now()));
    }
  }, [read, runId, toolResults]);

  useEffect(
    () => () => {
      run.current = undefined;
      clearTimeout(timer.current);
    },
    [],
  );

  return exhausted !== null && exhausted.runId === runId && exhausted.value;
}

/**
 * `text` for a polite live region, changed at most once per `ms`: a run that flips between
 * thinking and tools quickly is announced at a reading pace, ending on the latest phase.
 */
export function useThrottledText(text: string, ms: number): string {
  const [shown, setShown] = useState(text);
  const last = useRef(0);
  useEffect(() => {
    if (text === shown) return;
    const wait = last.current + ms - Date.now();
    const show = () => {
      last.current = Date.now();
      setShown(text);
    };
    if (wait <= 0) {
      show();
      return;
    }
    const timer = setTimeout(show, wait);
    return () => clearTimeout(timer);
  }, [text, shown, ms]);
  return shown;
}

/** Milliseconds since `since`, ticking once a second while `since` is set. */
export function useElapsed(since: string | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [since]);
  if (since === undefined) return undefined;
  const start = Date.parse(since);
  return Number.isNaN(start) ? undefined : now - start;
}
