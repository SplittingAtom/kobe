"use client";

import { useAuiState } from "@assistant-ui/react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { RunUsage, ThreadUsage } from "../../lib/admin/api/usage";
import { formatTokens, formatUsd } from "../../lib/admin/usage-format";
import type { KobeMessageMeta } from "../../lib/chat/tree";
import { useKobeExtras } from "./kobe-runtime";

/** Usage rows land a moment after a run ends (the gateway's flush); read them after this. */
const USAGE_SETTLE_MS = 1_500;
/** Reads again (2x, 4x the settle time) while the newest call isn't the ended run's yet. */
const USAGE_REREADS = 2;

/** A thread usage read and the run whose end it waited for (null: the read on open). */
export interface ThreadUsageRead {
  readonly usage: ThreadUsage;
  readonly afterRun: string | null;
}

const ThreadUsageContext = createContext<ThreadUsageRead | null>(null);

/** The open thread's latest usage read (the footers; the context gauge, KOBE-211). */
export function useThreadUsageRead(): ThreadUsageRead | null {
  return useContext(ThreadUsageContext);
}

/** After a run ended: its rows may not have landed while the newest call is another run's. */
function staleAfter(usage: ThreadUsage, ended: string | null): boolean {
  return ended !== null && usage.latestCall != null && usage.latestCall.runId !== ended;
}

/**
 * The open thread's usage per run (`GET /v1/threads/{id}/usage`, run_usage), read when the thread
 * opens and again after each run ends, for the answers' footers (CE12, KOBE-208) and the context
 * gauge (KOBE-211). After a run, a read whose newest call isn't that run's is read again, bounded.
 */
export function ThreadUsageProvider({ children }: { readonly children: ReactNode }) {
  const extras = useKobeExtras();
  const controller = extras?.controller;
  const threadId = extras?.state.threadId ?? null;
  const ended = extras?.state.live?.terminal ? extras.state.live.runId : null;
  const [read, setRead] = useState<ThreadUsageRead | null>(null);
  useEffect(() => {
    if (!controller || threadId === null) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (attempt: number) => {
      void controller.threadUsage()?.then((res) => {
        if (!current || !res.ok) return;
        setRead({ usage: res.data, afterRun: ended });
        if (attempt < USAGE_REREADS && staleAfter(res.data, ended)) {
          timer = setTimeout(() => read(attempt + 1), USAGE_SETTLE_MS * 2 ** (attempt + 1));
        }
      });
    };
    if (ended === null) read(0);
    else timer = setTimeout(() => read(0), USAGE_SETTLE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [controller, threadId, ended]);
  const value = read !== null && read.usage.threadId === threadId ? read : null;
  return <ThreadUsageContext.Provider value={value}>{children}</ThreadUsageContext.Provider>;
}

/**
 * The run that wrote this answer: each run commits its own prompt entry (`runs.user_entry_id`;
 * edit, regenerate and Retry all send a new prompt), so the prompt names exactly one run.
 */
function runOf(usage: ThreadUsage | null, promptId: string | undefined): RunUsage | undefined {
  if (usage === null || promptId === undefined) return undefined;
  return usage.runs.find((r) => r.userEntryId === promptId);
}

function usageParts(run: RunUsage | undefined): string[] {
  if (!run) return [];
  return [
    ...(run.models.length > 0 ? [run.models.join(", ")] : []),
    `${formatTokens(run.inputTokens)} in`,
    `${formatTokens(run.outputTokens)} out`,
    ...(run.unpricedCalls < run.calls ? [formatUsd(run.costUsd)] : []),
  ];
}

function clock(iso: string): { readonly short: string; readonly full: string } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return {
    short: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    full: date.toLocaleString(),
  };
}

/**
 * An answer's footer (CE12): model, tokens in and out and cost of the run that wrote it
 * (run_usage), and when it was stored. Shown on hover or focus where there is hover.
 */
export function MessageFooter() {
  const meta = useAuiState((s) => s.message.metadata.custom as KobeMessageMeta | undefined);
  const usage = useContext(ThreadUsageContext)?.usage ?? null;
  if (meta?.kind !== "assistant" || meta.live || meta.at === undefined) return null;
  const time = clock(meta.at);
  const parts = usageParts(runOf(usage, meta.promptEntryId));
  if (parts.length === 0 && time === null) return null;
  return (
    <div
      role="group"
      aria-label="Answer details"
      className="text-muted-foreground ms-auto flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs tabular-nums [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/answer:opacity-100 [@media(hover:hover)]:group-hover/answer:opacity-100"
    >
      {[
        ...parts.map((part) => <span key={part}>{part}</span>),
        ...(time
          ? [
              <time key="time" dateTime={meta.at} title={time.full}>
                {time.short}
              </time>,
            ]
          : []),
      ].flatMap((item, i) =>
        i === 0
          ? [item]
          : [
              <span key={`dot${i}`} aria-hidden>
                ·
              </span>,
              item,
            ],
      )}
    </div>
  );
}
