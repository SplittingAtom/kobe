"use client";

import { ThreadPrimitive } from "@assistant-ui/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { isThreadRunning } from "../../lib/chat/thread-state";
import type { RunnableAgent } from "../../lib/chat/types";
import { useChatSession, type KobeThreadExtras } from "./kobe-runtime";

const CHIP =
  "border-foreground/15 hover:bg-foreground/[0.04] focus-visible:ring-ring/50 max-w-full truncate rounded-full border bg-transparent px-3 py-1 text-start text-sm transition-colors outline-none focus-visible:ring-2 disabled:opacity-50 motion-reduce:transition-none";

/** The runnable agents, read once per session (cached by the session). */
function useRunnableAgents(): readonly RunnableAgent[] {
  const session = useChatSession();
  const [agents, setAgents] = useState<readonly RunnableAgent[]>([]);
  useEffect(() => {
    let current = true;
    session.agents().then(
      (res) => {
        if (current && res.ok) setAgents(res.data);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [session]);
  return agents;
}

/**
 * The starters of the conversation's agent (D19, KOBE-222): the draft's pick before the thread
 * exists, else the agent the thread pins. Empty without an agent or when it has none.
 */
export function useAgentStarters(extras: KobeThreadExtras): readonly string[] {
  const session = useChatSession();
  const draft = useSyncExternalStore(
    session.subscribeDraftAgent,
    () => session.draftAgent,
    () => null,
  );
  const agents = useRunnableAgents();
  const { state } = extras;
  // A reader of a shared thread cannot send here (review S4).
  if (state.summary?.readOnly === true) return [];
  if (state.threadId === null) return draft?.starters ?? [];
  const agentId = state.summary?.agentId;
  if (agentId == null) return [];
  return agents.find((a) => a.id === agentId)?.starters ?? [];
}

/** The agent's starters on the welcome screen: a chip sends its text as the first message. */
export function AgentStarters({ starters }: { readonly starters: readonly string[] }) {
  return (
    <div
      role="group"
      aria-label="Conversation starters"
      className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both flex flex-wrap gap-2 duration-200"
    >
      {starters.map((starter) => (
        <ThreadPrimitive.Suggestion key={starter} prompt={starter} send asChild>
          <button type="button" className={CHIP} title={starter}>
            {starter}
          </button>
        </ThreadPrimitive.Suggestion>
      ))}
    </div>
  );
}

/**
 * Follow-ups the server suggested after the last answer (KOBE-222, CE21): chips above the
 * composer until the next send; a chip sends its text (a draft in the composer stays). Never for
 * a reader of a shared thread: they cannot send here.
 */
export function FollowupChips({ extras }: { readonly extras: KobeThreadExtras }) {
  const { state } = extras;
  const followups = state.followups;
  if (
    !followups ||
    state.summary === undefined ||
    state.summary.readOnly === true ||
    state.summary.deletedAt != null ||
    state.sending !== undefined ||
    isThreadRunning(state)
  ) {
    return null;
  }
  return (
    <div
      role="group"
      aria-label="Suggested follow-ups"
      data-kobe-followups
      className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both flex flex-wrap gap-2 duration-200"
    >
      {followups.suggestions.map((text) => (
        <ThreadPrimitive.Suggestion key={text} prompt={text} send clearComposer={false} asChild>
          <button type="button" className={CHIP} title={text}>
            {text}
          </button>
        </ThreadPrimitive.Suggestion>
      ))}
    </div>
  );
}
