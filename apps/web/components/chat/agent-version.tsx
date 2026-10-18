"use client";

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
      ? "Switch when the run ends"
      : state.busy.includes(BUSY)
        ? "Switching…"
        : undefined,
  };
}

/**
 * "v<N> available" in the thread header (U8: "badge on old threads, one-click switch"). Switch
 * moves the thread to that version through `POST /v1/threads/:id/agent-version`; the next run uses
 * it and the server marks the switch above its prompt. Refusals show as the thread's action error.
 */
export function AgentVersionBadge({ extras }: { readonly extras: KobeThreadExtras }) {
  const offer = agentVersionOffer(extras.state);
  if (!offer) return null;
  const { current, pinned, agentName, canSwitch, blocker } = offer;
  const controller = extras.controller;
  return (
    <span
      role="group"
      aria-label={`${agentName} v${current} available. This thread uses v${pinned}.`}
      data-kobe-agent-version={current}
      className="inline-flex items-center gap-1.5"
    >
      <span
        title={`This thread uses v${pinned}. New threads use v${current}.`}
        className="border-border text-muted-foreground inline-flex items-center rounded-full border px-2 text-xs leading-5"
      >
        v{current} available
      </span>
      {canSwitch && controller && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-label={`Switch this thread to v${current}`}
          title={blocker ?? `Your next message uses v${current}`}
          disabled={blocker !== undefined}
          onClick={() => void controller.switchAgentVersion()}
        >
          Switch
        </Button>
      )}
    </span>
  );
}
