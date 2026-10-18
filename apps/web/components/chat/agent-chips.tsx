"use client";

import { useDraftAgentName } from "./agent-picker";
import { useKobeExtras } from "./kobe-runtime";

/**
 * The thread's agent as chips: its name (the draft's choice before the thread exists) and, when it
 * can no longer run, Suspended or Archived. Fixed once the conversation exists, in the composer's
 * toolbar (KOBE-418).
 */
export function AgentChips() {
  const summary = useKobeExtras()?.state.summary;
  const draftName = useDraftAgentName();
  const name = summary?.agentName ?? (summary?.agentId == null ? draftName : null);
  if (!name) return null;
  const status = summary?.agentStatus;
  return (
    <>
      <span
        className="text-muted-foreground inline-block h-7 max-w-48 min-w-0 shrink truncate rounded-full border px-2.5 text-xs leading-[1.625rem]"
        title={name}
      >{`Agent: ${name}`}</span>
      {(status === "suspended" || status === "archived") && (
        <span className="text-destructive border-destructive/40 inline-flex h-7 shrink-0 items-center rounded-full border px-2.5 text-xs">
          {status === "suspended" ? "Suspended" : "Archived"}
        </span>
      )}
    </>
  );
}
