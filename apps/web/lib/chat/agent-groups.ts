/**
 * The chat's agent picker groups (spec agents-roster AR15, KOBE-571): Personal, Team, Site, in
 * that order, from the server's `group` (the roster each runnable agent comes from). An older
 * server without it: personal agents are Personal, team agents Team, gallery agents Site. Order
 * within a group is the server's.
 */
import type { RunnableAgent, RunnableGroup } from "./types";

export const AGENT_GROUPS: readonly { readonly id: RunnableGroup; readonly label: string }[] = [
  { id: "personal", label: "Personal" },
  { id: "team", label: "Team" },
  { id: "site", label: "Site" },
];

const FROM_SCOPE: Readonly<Record<RunnableAgent["scope"], RunnableGroup>> = {
  personal: "personal",
  team: "team",
  gallery: "site",
};

export const agentGroup = (agent: RunnableAgent): RunnableGroup =>
  agent.group ?? FROM_SCOPE[agent.scope];

export interface AgentGroup {
  readonly id: RunnableGroup;
  readonly label: string;
  readonly agents: readonly RunnableAgent[];
}

/** The non-empty groups, in the picker's order. */
export function groupAgents(agents: readonly RunnableAgent[]): AgentGroup[] {
  return AGENT_GROUPS.map((g) => ({
    ...g,
    agents: agents.filter((a) => agentGroup(a) === g.id),
  })).filter((g) => g.agents.length > 0);
}
