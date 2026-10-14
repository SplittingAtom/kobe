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

/** The thread actions menu's button, else the gauge: visible targets for focus after the dialog. */
const actionsTrigger = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('summary[aria-label="Conversation actions"]') ??
  document.querySelector<HTMLElement>("[data-context-gauge]");

/**
 * Bar row two (CE3, KOBE-197): the open thread's context. Rendered into the bar's context slot by
 * the workspace, inside the assistant-ui runtime.
 */
export function ContextRow() {
  const extras = useKobeExtras();
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  // The thread whose Compact dialog is open: never another thread's (CE15, KOBE-213).
  const [compactFor, setCompactFor] = useState<string | null>(null);
  if (!extras) return null;
  const { controller, state } = extras;
  // A shared conversation is read-only and one in Trash can't run: no model to choose.
  const canRun = state.summary?.readOnly !== true && state.summary?.deletedAt == null;
  // Compact now (CE15, KOBE-213): the owner's saved thread only; enabled while idle.
  const blocker = compactBlocker(state);
  const threadId = state.threadId;
  const openCompact =
    canRun && controller !== null && threadId !== null ? () => setCompactFor(threadId) : undefined;
  return (
    <>
      <AgentControl />
      {canRun && (
        <ModelPicker controller={controller} state={state} isNew={remoteId === undefined} />
      )}
      <ThreadContextGauge compactBlocker={blocker} onCompact={openCompact} />
      <FilesButton />
      <DetailToggle />
      {openCompact && controller !== null && threadId !== null && (
        <>
          <ThreadActionsMenu blocker={blocker} onCompact={openCompact} />
          <CompactDialog
            key={threadId}
            controller={controller}
            open={compactFor === threadId}
            // Closing (or finishing) this thread's dialog never touches another thread's.
            onOpenChange={(open) =>
              setCompactFor((current) => (open ? threadId : current === threadId ? null : current))
            }
            returnFocus={actionsTrigger}
          />
        </>
      )}
      {/* Slot: branch indicator (CE16, KOBE-214/216). */}
    </>
  );
}
