"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { modelName, type TeamModels } from "../../lib/admin/api/team/models";
import type { RunnableAgent } from "../../lib/chat/types";
import { cn } from "../../lib/utils";
import { useChatSession } from "./kobe-runtime";

type Agents = readonly RunnableAgent[];

/** The team's runnable agents, or an empty list while loading or when they can't be read. */
function useAgents(): Agents {
  const session = useChatSession();
  const [agents, setAgents] = useState<Agents>([]);
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

/** The name of the agent picked for a conversation not created yet (null: plain chat). */
export function useDraftAgentName(): string | null {
  const session = useChatSession();
  const draft = useSyncExternalStore(
    session.subscribeDraftAgent,
    () => session.draftAgent,
    () => null,
  );
  return draft?.name ?? null;
}

const OPTION =
  "border-foreground/10 has-[:checked]:border-foreground/40 has-[:checked]:bg-muted/50 has-[:focus-visible]:ring-ring/50 hover:bg-muted/30 flex cursor-pointer flex-col gap-0.5 rounded-lg border px-3 py-2 text-start text-sm transition-colors has-[:focus-visible]:ring-2 motion-reduce:transition-none";

/**
 * Who a new conversation is with (KOBE-122): no agent (a plain chat, the default) or one of the
 * agents the server says the user can run here. Native radios, so Tab, arrow keys and Space work
 * and screen readers announce the group. Rendered only for a conversation not created yet; renders
 * nothing when there is no agent to pick.
 */
export function AgentPicker() {
  const session = useChatSession();
  const id = useId();
  const agents = useAgents();
  const [models, setModels] = useState<TeamModels | null>(null);
  const chosen = useSyncExternalStore(
    session.subscribeDraftAgent,
    () => session.draftAgent,
    () => null,
  );

  useEffect(() => {
    let current = true;
    session.models().then(
      (res) => {
        if (current && res.ok) setModels(res.data);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [session]);

  if (agents.length === 0) return null;
  const modelLabel = (alias: string) => {
    const m = models?.models.find((x) => x.alias === alias);
    return m ? modelName(m) : alias;
  };

  return (
    <div role="radiogroup" aria-labelledby={`${id}-legend`} className="flex flex-col gap-1.5 px-2">
      <p id={`${id}-legend`} className="text-muted-foreground text-xs font-medium">
        Chat with
      </p>
      <div className="grid max-h-56 gap-1.5 overflow-y-auto @md:grid-cols-2">
        <label className={OPTION}>
          <input
            type="radio"
            name={`${id}-agent`}
            className="sr-only"
            checked={chosen === null}
            onChange={() => session.setDraftAgent(null)}
          />
          <span className="font-medium">No agent</span>
          <span className="text-muted-foreground text-xs">A plain conversation</span>
        </label>
        {agents.map((agent) => (
          <label key={agent.id} className={OPTION}>
            <input
              type="radio"
              name={`${id}-agent`}
              className="sr-only"
              checked={chosen?.id === agent.id}
              onChange={() => session.setDraftAgent(agent)}
            />
            <span className="font-medium">{agent.name}</span>
            {agent.description && (
              <span className="text-muted-foreground line-clamp-2 text-xs">
                {agent.description}
              </span>
            )}
            {agent.model !== null && (
              <span className={cn("text-muted-foreground text-xs")}>
                Model: {modelLabel(agent.model)}
              </span>
            )}
          </label>
        ))}
      </div>
    </div>
  );
}
