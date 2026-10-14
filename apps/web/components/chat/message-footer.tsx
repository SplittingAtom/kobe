"use client";

import { useAuiState } from "@assistant-ui/react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { RunUsage, ThreadUsage } from "../../lib/admin/api/usage";
import { formatTokens, formatUsd } from "../../lib/admin/usage-format";
import type { KobeMessageMeta } from "../../lib/chat/tree";
import { useKobeExtras } from "./kobe-runtime";

/** Usage rows land a moment after a run ends (the gateway's flush); read them after this. */
const USAGE_SETTLE_MS = 1_500;

const ThreadUsageContext = createContext<ThreadUsage | null>(null);

/**
 * The open thread's usage per run (`GET /v1/threads/{id}/usage`, run_usage), read when the thread
 * opens and again after each run ends, for the answers' footers (CE12, KOBE-208).
 */
export function ThreadUsageProvider({ children }: { readonly children: ReactNode }) {
  const extras = useKobeExtras();
  const controller = extras?.controller;
  const threadId = extras?.state.threadId ?? null;
  const ended = extras?.state.live?.terminal ? extras.state.live.runId : null;
  const [usage, setUsage] = useState<ThreadUsage | null>(null);
  useEffect(() => {
    if (!controller || threadId === null) return;
    let current = true;
    const read = () => {
      void controller.threadUsage()?.then((res) => {
        if (current && res.ok) setUsage(res.data);
      });
    };
    const timer = ended === null ? undefined : setTimeout(read, USAGE_SETTLE_MS);
    if (ended === null) read();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [controller, threadId, ended]);
  const value = usage !== null && usage.threadId === threadId ? usage : null;
  return <ThreadUsageContext.Provider value={value}>{children}</ThreadUsageContext.Provider>;
}

/** The runs that answered this prompt (a retry is a second run on the same prompt). */
function runsOf(usage: ThreadUsage | null, promptId: string | null): readonly RunUsage[] {
  if (usage === null || promptId === null) return [];
  return usage.runs.filter((r) => r.userEntryId === promptId);
}

function usageParts(runs: readonly RunUsage[]): string[] {
  if (runs.length === 0) return [];
  const sum = (pick: (r: RunUsage) => number) => runs.reduce((n, r) => n + pick(r), 0);
  const models = [...new Set(runs.flatMap((r) => r.models))];
  const priced = sum((r) => r.unpricedCalls) < sum((r) => r.calls);
  return [
    ...(models.length > 0 ? [models.join(", ")] : []),
    `${formatTokens(sum((r) => r.inputTokens))} in`,
    `${formatTokens(sum((r) => r.outputTokens))} out`,
    ...(priced ? [formatUsd(sum((r) => r.costUsd))] : []),
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
  const promptId = useAuiState((s) => s.message.parentId);
  const usage = useContext(ThreadUsageContext);
  if (meta?.kind !== "assistant" || meta.live || meta.at === undefined) return null;
  const time = clock(meta.at);
  const parts = usageParts(runsOf(usage, promptId));
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
