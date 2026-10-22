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

/** Whether the agent picked for a conversation not created yet is a Dangerous agent (KOBE-476). */
export function useDraftAgentDangerous(): boolean {
  const session = useChatSession();
  const draft = useSyncExternalStore(
    session.subscribeDraftAgent,
    () => session.draftAgent,
    () => null,
  );
  return draft?.dangerous === true;
}

const OPTION =
  "border-foreground/10 has-[:checked]:border-foreground/40 has-[:checked]:bg-muted/50 has-[:focus-visible]:ring-ring/50 hover:bg-muted/30 flex cursor-pointer flex-col gap-0.5 rounded-lg border px-3 py-2 text-start text-sm transition-colors has-[:focus-visible]:ring-2 motion-reduce:transition-none";

/** What the radios show chosen and what a choice does: the draft's agent, or a thread's (KOBE-458). */
interface AgentChoice {
  readonly chosenId: string | null;
  readonly choose: (agent: RunnableAgent | null) => void;
}

/**
 * Who a conversation is with (KOBE-122): no agent (a plain chat) or one of the agents the server
 * says the user can run here. Native radios, so Tab, arrow keys and Space work and screen readers
 * announce the group. For a conversation not created yet, or one that has no agent (KOBE-458).
 */
function AgentPicker({
  agents,
  labels,
  models,
  choice,
}: {
  readonly agents: Agents;
  readonly labels: ReadonlyMap<string, AgentLabel>;
  readonly models: TeamModels | null;
  readonly choice: AgentChoice;
}) {
  const id = useId();
  const { chosenId, choose } = choice;

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
            checked={chosenId === null}
            onChange={() => choose(null)}
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
                aria-label={`${agentChoiceName(agent, label)}${agent.dangerous ? ", Dangerous" : ""}`}
                checked={chosenId === agent.id}
                onChange={() => choose(agent)}
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
                {agent.dangerous && (
                  <span className="text-destructive border-destructive/40 rounded border px-1 text-[0.6875rem] leading-4 font-medium">
                    Dangerous
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
  const draft = useSyncExternalStore(
    session.subscribeDraftAgent,
    () => session.draftAgent,
    () => null,
  );
  const choice = useMemo<AgentChoice>(
    () => ({ chosenId: draft?.id ?? null, choose: (agent) => session.setDraftAgent(agent) }),
    [draft, session],
  );
  return <PickerPopover choice={choice} fallback={draft} />;
}

/**
 * The picker for a started conversation that has no agent (KOBE-458 ac-3, e.g. one a rail launch
 * started before it took the default agent): choosing one gives the thread that agent for its next
 * runs (`chooseAgent`), after which the fixed chip shows it. "No agent" keeps it as it is.
 */
export function ThreadAgentPickerMenu({
  onChoose,
}: {
  readonly onChoose: (agent: RunnableAgent) => void;
}) {
  const choice = useMemo<AgentChoice>(
    () => ({ chosenId: null, choose: (agent) => agent && onChoose(agent) }),
    [onChoose],
  );
  return <PickerPopover choice={choice} fallback={null} />;
}

function PickerPopover({
  choice,
  fallback,
}: {
  readonly choice: AgentChoice;
  /** The chosen agent when the list doesn't have it (yet). */
  readonly fallback: RunnableAgent | null;
}) {
  const agents = useAgents();
  const models = useTeamModels();
  const labels = useMemo(() => agentLabels(agents), [agents]);
  if (agents.length === 0) return null;
  const { chosenId } = choice;
  const listed = chosenId === null ? undefined : agents.find((a) => a.id === chosenId);
  const shown = listed ?? fallback;
  const chosen = chosenId === null || !shown ? null : chosenAgentText(shown, labels.get(chosenId));
  return (
    <Popover.Root>
      <Popover.Trigger className="hover:bg-muted text-muted-foreground inline-flex h-7 max-w-48 min-w-0 shrink items-center gap-1 rounded-full border px-2.5 text-xs">
        <span className="min-w-0 truncate">{`Chat with: ${chosen ?? "No agent"}`}</span>
        {chosen !== null && shown?.dangerous && (
          <span className="text-destructive shrink-0 font-medium">Dangerous</span>
        )}
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />
      </Popover.Trigger>
      <Popover.Content
        side="top"
        align="start"
        sideOffset={4}
        className="bg-background z-50 w-80 rounded-lg border p-2 shadow-md"
      >
        <AgentPicker agents={agents} labels={labels} models={models} choice={choice} />
      </Popover.Content>
    </Popover.Root>
  );
}
