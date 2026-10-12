"use client";

import { useAuiState } from "@assistant-ui/react";
import { AgentPickerMenu, useDraftAgentName } from "../chat/agent-picker";
import { useChatSession, useKobeExtras } from "../chat/kobe-runtime";
import { ModelPicker } from "../chat/model-picker";
import { FilesToggleButton } from "../files/files-panel";

const CHIP = "text-muted-foreground rounded-full border px-2 text-xs";

/** The thread's agent: the picker while the conversation is new, then its name (and state). */
function AgentControl() {
  const session = useChatSession();
  const state = useKobeExtras()?.state;
  const summary = state?.summary;
  const draftName = useDraftAgentName();
  if (state?.threadId === null && session.canChooseAgent) return <AgentPickerMenu />;
  const name = summary?.agentName ?? (summary?.agentId == null ? draftName : null);
  if (!name) return null;
  const status = summary?.agentStatus;
  return (
    <>
      <span className={CHIP}>{`Agent: ${name}`}</span>
      {(status === "suspended" || status === "archived") && (
        <span className="text-destructive border-destructive/40 rounded-full border px-2 text-xs">
          {status === "suspended" ? "Suspended" : "Archived"}
        </span>
      )}
    </>
  );
}

/**
 * Bar row two (CE3, KOBE-197): the open thread's context. Rendered into the bar's context slot by
 * the workspace, inside the assistant-ui runtime.
 */
export function ContextRow() {
  const extras = useKobeExtras();
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  if (!extras) return null;
  const { controller, state } = extras;
  // A shared conversation is read-only and one in Trash can't run: no model to choose.
  const canRun = state.summary?.readOnly !== true && state.summary?.deletedAt == null;
  return (
    <>
      <AgentControl />
      {canRun && (
        <ModelPicker controller={controller} state={state} isNew={remoteId === undefined} />
      )}
      {/* Slot: context gauge (CE14, KOBE-211). */}
      <FilesToggleButton />
      {/* Slot: Detail toggle (CE12, KOBE-208). */}
      {/* Slot: branch indicator (CE16, KOBE-214/216). */}
    </>
  );
}
