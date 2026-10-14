"use client";

import { useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { compactBlocker } from "../../lib/chat/thread-state";
import { CompactDialog } from "../chat/compact-dialog";
import { AgentChips } from "../chat/agent-chips";
import { AgentPickerMenu } from "../chat/agent-picker";
import { DetailToggle } from "../chat/detail";
import { useChatSession, useKobeExtras } from "../chat/kobe-runtime";
import { ModelPicker } from "../chat/model-picker";
import { ThreadActionsMenu } from "../chat/thread-actions";
import { ThreadContextGauge } from "./context-gauge";
import { FilesButton } from "./rail-state";

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
  const [compacting, setCompacting] = useState(false);
  if (!extras) return null;
  const { controller, state } = extras;
  // A shared conversation is read-only and one in Trash can't run: no model to choose.
  const canRun = state.summary?.readOnly !== true && state.summary?.deletedAt == null;
  // Compact now (CE15, KOBE-213): the owner's saved thread only; enabled while idle.
  const blocker = compactBlocker(state);
  const compactable = canRun && controller !== null && state.threadId !== null;
  const openCompact = compactable ? () => setCompacting(true) : undefined;
  return (
    <>
      <AgentControl />
      {canRun && (
        <ModelPicker controller={controller} state={state} isNew={remoteId === undefined} />
      )}
      <ThreadContextGauge compactBlocker={blocker} onCompact={openCompact} />
      <FilesButton />
      <DetailToggle />
      {compactable && openCompact && (
        <>
          <ThreadActionsMenu blocker={blocker} onCompact={openCompact} />
          <CompactDialog controller={controller} open={compacting} onOpenChange={setCompacting} />
        </>
      )}
      {/* Slot: branch indicator (CE16, KOBE-214/216). */}
    </>
  );
}
