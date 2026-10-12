"use client";

import { useDraftAgentName } from "./agent-picker";
import { useKobeExtras } from "./kobe-runtime";

/**
 * The thread's agent as chips: its name (the draft's choice before the thread exists) and, when it
 * can no longer run, Suspended or Archived. In bar row two in the chat (KOBE-197), in the thread
 * header in the builder's test pane.
 */
export function AgentChips() {
  const summary = useKobeExtras()?.state.summary;
  const draftName = useDraftAgentName();
  const name = summary?.agentName ?? (summary?.agentId == null ? draftName : null);
  if (!name) return null;
  const status = summary?.agentStatus;
  return (
    <>
      <span className="text-muted-foreground rounded-full border px-2 text-xs">{`Agent: ${name}`}</span>
      {(status === "suspended" || status === "archived") && (
        <span className="text-destructive border-destructive/40 rounded-full border px-2 text-xs">
          {status === "suspended" ? "Suspended" : "Archived"}
        </span>
      )}
    </>
  );
}
