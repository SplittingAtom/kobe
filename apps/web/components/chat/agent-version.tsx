"use client";

import { useId } from "react";
import { isThreadRunning, type ThreadState } from "../../lib/chat/thread-state";
import { Button } from "../ui/button";
import type { KobeThreadExtras } from "./kobe-runtime";

/** What the header offers a thread pinned to an older agent version (D19, U8, KOBE-420). */
export interface AgentVersionOffer {
  readonly pinned: number;
  readonly current: number;
  readonly agentName: string;
  /** False for a reader of a shared thread, and while the agent can't be switched to. */
  readonly canSwitch: boolean;
  /** Why Switch waits, when it does. */
  readonly blocker?: string | undefined;
}

const BUSY = "agent-version";

/** The offer, or undefined when the thread has no agent or is on its current version. */
export function agentVersionOffer(state: ThreadState): AgentVersionOffer | undefined {
  const summary = state.summary;
  const pinned = summary?.agentVersion;
  const current = state.agentCurrentVersion;
  if (!summary || summary.agentId === null || pinned == null || current == null) return undefined;
  if (current <= pinned || summary.deletedAt != null) return undefined;
  const status = summary.agentStatus ?? "active";
  return {
    pinned,
    current,
    agentName: summary.agentName ?? "The agent",
    canSwitch: summary.readOnly !== true && status === "active",
    blocker: isThreadRunning(state)
      ? "Switch when the run ends."
      : state.busy.includes(BUSY)
        ? "Switching…"
        : undefined,
  };
}

/** After a switch the offer (and its focused button) goes: the composer is where the member goes next. */
function focusComposer(root: ParentNode): void {
  root.querySelector<HTMLTextAreaElement>("[data-kobe-composer] textarea")?.focus();
}

/**
 * "v<N> available" in the thread header (U8: "badge on old threads, one-click switch"). Switch
 * moves the thread to that version through `POST /v1/threads/:id/agent-version`; the next run uses
 * it and the server marks the change above its prompt. Refusals show as the thread's action error.
 * While Switch waits (a run is active) it stays focusable, says why in its description and does
 * nothing.
 */
export function AgentVersionBadge({ extras }: { readonly extras: KobeThreadExtras }) {
  const reasonId = useId();
  const offer = agentVersionOffer(extras.state);
  if (!offer) return null;
  const { current, pinned, agentName, canSwitch, blocker } = offer;
  const controller = extras.controller;
  const onSwitch = async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (blocker !== undefined || !controller) return;
    // Found before the await: the button is gone (detached) once the switch is done.
    const root = event.currentTarget.closest("[data-kobe-thread-root]") ?? document;
    if (await controller.switchAgentVersion()) focusComposer(root);
  };
  return (
    <span
      role="group"
      aria-label={`${agentName} v${current} available. This thread uses v${pinned}.`}
      data-kobe-agent-version={current}
      className="inline-flex items-center gap-1.5"
    >
      <span className="border-border text-muted-foreground inline-flex items-center rounded-full border px-2 text-xs leading-5">
        v{current} available
      </span>
      {canSwitch && controller && (
        <>
          <Button
            type="button"
            size="xs"
            variant="outline"
            aria-label={`Switch this thread to v${current}`}
            aria-disabled={blocker !== undefined || undefined}
            aria-describedby={reasonId}
            title={blocker ?? `Your next message uses v${current}`}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onClick={(event) => void onSwitch(event)}
          >
            Switch
          </Button>
          <span id={reasonId} className="sr-only">
            {blocker ?? `Your next message uses v${current}.`}
          </span>
        </>
      )}
    </span>
  );
}
