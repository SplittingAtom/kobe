"use client";

import { ChevronDownIcon } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { modelName, type TeamModels } from "../../lib/admin/api/team/models";
import {
  agentChoiceName,
  agentLabels,
  chosenAgentText,
  type AgentLabel,
} from "../../lib/chat/agent-origin";
import type { RunnableAgent } from "../../lib/chat/types";
import { cn } from "../../lib/utils";
import { useChatSession } from "./kobe-runtime";

type Agents = readonly RunnableAgent[];

/** The team's models (to name an agent's pinned model), or null while loading or unreadable. */
function useTeamModels(): TeamModels | null {
  const session = useChatSession();
  const [models, setModels] = useState<TeamModels | null>(null);
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
  return models;
}

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
 * and screen readers announce the group. Rendered only for a conversation not created yet.
 */
function AgentPicker({
  agents,
  labels,
  models,
}: {
  readonly agents: Agents;
  readonly labels: ReadonlyMap<string, AgentLabel>;
  readonly models: TeamModels | null;
}) {
  const session = useChatSession();
  const id = useId();
  const chosen = useSyncExternalStore(
    session.subscribeDraftAgent,
    () => session.draftAgent,
    () => null,
  );

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
        {agents.map((agent) => {
          const label = labels.get(agent.id);
          return (
            <label key={agent.id} className={OPTION}>
              <input
                type="radio"
                name={`${id}-agent`}
                className="sr-only"
                aria-label={agentChoiceName(agent, label)}
                checked={chosen?.id === agent.id}
                onChange={() => session.setDraftAgent(agent)}
              />
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
                <span className="font-medium">{agent.name}</span>
                {label && (
                  <span className="text-muted-foreground rounded border px-1 text-[0.6875rem] leading-4">
                    {label.origin}
                  </span>
                )}
                {label?.slug !== undefined && (
                  <span className="text-muted-foreground font-mono text-[0.6875rem]">
                    {label.slug}
                  </span>
                )}
              </span>
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
          );
        })}
      </div>
    </div>
  );
}

/**
 * The agent picker in the composer's toolbar (KOBE-418; bar row two before, CE3 KOBE-197): a chip
 * naming the choice that opens the radios in a popover above it. Renders nothing when there is no
 * agent to pick. The lists are read here, once, not by the popover's content, which mounts on
 * every open.
 */
export function AgentPickerMenu() {
  const session = useChatSession();
  const agents = useAgents();
  const models = useTeamModels();
  const labels = useMemo(() => agentLabels(agents), [agents]);
  const draft = useSyncExternalStore(
    session.subscribeDraftAgent,
    () => session.draftAgent,
    () => null,
  );
  if (agents.length === 0) return null;
  const listed = draft === null ? undefined : agents.find((a) => a.id === draft.id);
  const chosen = draft === null ? null : chosenAgentText(listed ?? draft, labels.get(draft.id));
  return (
    <Popover.Root>
      <Popover.Trigger className="hover:bg-muted text-muted-foreground inline-flex h-7 max-w-48 min-w-0 shrink items-center gap-1 rounded-full border px-2.5 text-xs">
        <span className="min-w-0 truncate">{`Chat with: ${chosen ?? "No agent"}`}</span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />
      </Popover.Trigger>
      <Popover.Content
        side="top"
        align="start"
        sideOffset={4}
        className="bg-background z-50 w-80 rounded-lg border p-2 shadow-md"
      >
        <AgentPicker agents={agents} labels={labels} models={models} />
      </Popover.Content>
    </Popover.Root>
  );
}
