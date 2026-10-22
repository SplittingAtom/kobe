"use client";

import { cn } from "../../lib/utils";
import { useDraftAgentName, useDraftAgentDangerous } from "./agent-picker";
import { DangerousChip } from "./dangerous-chip";
import { useKobeExtras } from "./kobe-runtime";

/**
 * The thread's agent as chips: its name (the draft's choice before the thread exists) and, when it
 * can no longer run, Suspended or Archived. Fixed once the conversation exists, on the line below
 * the composer (KOBE-450; compact there).
 */
export function AgentChips({ compact = false }: { readonly compact?: boolean } = {}) {
  const summary = useKobeExtras()?.state.summary;
  const draftName = useDraftAgentName();
  const draftDangerous = useDraftAgentDangerous();
  // The draft's choice only before the thread exists: a started agentless thread has no agent
  // (KOBE-458: it showed the draft's default as if the thread had it).
  const name = summary ? (summary.agentName ?? null) : draftName;
  if (!name) return null;
  const status = summary?.agentStatus;
  const dangerous = summary ? summary.agentDangerous === true : draftDangerous;
  return (
    <>
      <span
        className={cn(
          "text-muted-foreground inline-block max-w-48 min-w-0 shrink truncate rounded-full border px-2.5 text-xs",
          compact ? "h-6 leading-[1.375rem]" : "h-7 leading-[1.625rem]",
        )}
        title={name}
      >{`Agent: ${name}`}</span>
      {dangerous && <DangerousChip compact={compact} />}
      {(status === "suspended" || status === "archived") && (
        <span
          className={cn(
            "text-destructive border-destructive/40 inline-flex shrink-0 items-center rounded-full border px-2.5 text-xs",
            compact ? "h-6" : "h-7",
          )}
        >
          {status === "suspended" ? "Suspended" : "Archived"}
        </span>
      )}
    </>
  );
}
