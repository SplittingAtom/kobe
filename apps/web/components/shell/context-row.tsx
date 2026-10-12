"use client";

import { useAuiState } from "@assistant-ui/react";
import { AgentChips } from "../chat/agent-chips";
import { AgentPickerMenu } from "../chat/agent-picker";
import { useChatSession, useKobeExtras } from "../chat/kobe-runtime";
import { ModelPicker } from "../chat/model-picker";
import { FilesToggleButton } from "../files/files-panel";

/** The thread's agent: the picker while the conversation is new, then its name (and state). */
function AgentControl() {
  const session = useChatSession();
  const isNew = useKobeExtras()?.state.threadId === null;
  return isNew && session.canChooseAgent ? <AgentPickerMenu /> : <AgentChips />;
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
