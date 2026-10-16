import type { RunnableAgent } from "./types";

/**
 * Where an agent comes from (KOBE-297), so two agents with the same name (the gallery's Kobe and a
 * team's fork of it) are told apart in the composer's picker: Built-in (the site gallery), Team
 * or Personal. Equal names with the same origin also show the agent's slug, which is unique there.
 */
export const ORIGIN_LABELS: Readonly<Record<RunnableAgent["scope"], string>> = {
  gallery: "Built-in",
  team: "Team",
  personal: "Personal",
};

export interface AgentLabel {
  readonly origin: string;
  /** Another listed agent has the same name. */
  readonly sharedName: boolean;
  /** The slug, when another agent has the same name and origin. */
  readonly slug?: string;
}

const key = (a: RunnableAgent) => a.name.trim().toLowerCase();

export function agentLabels(agents: readonly RunnableAgent[]): ReadonlyMap<string, AgentLabel> {
  const byName = new Map<string, RunnableAgent[]>();
  for (const a of agents) byName.set(key(a), [...(byName.get(key(a)) ?? []), a]);
  const out = new Map<string, AgentLabel>();
  for (const a of agents) {
    const same = byName.get(key(a)) ?? [];
    const sameOrigin = same.filter((b) => b.scope === a.scope).length > 1;
    out.set(a.id, {
      origin: ORIGIN_LABELS[a.scope],
      sharedName: same.length > 1,
      ...(sameOrigin && a.slug !== undefined ? { slug: a.slug } : {}),
    });
  }
  return out;
}

const details = (label: AgentLabel) =>
  [label.origin, ...(label.slug === undefined ? [] : [label.slug])].join(", ");

/** The radio's accessible name: "Kobe, Built-in", or "Kobe, Team, kobe-ops". */
export function agentChoiceName(agent: RunnableAgent, label: AgentLabel | undefined): string {
  return label ? `${agent.name}, ${details(label)}` : agent.name;
}

/** The chosen agent on the picker's button: its name, with its origin where the name is shared. */
export function chosenAgentText(agent: RunnableAgent, label: AgentLabel | undefined): string {
  return label?.sharedName ? `${agent.name} (${details(label)})` : agent.name;
}
