import { agentSkills, type AgentFrontmatter } from "@kobe/agent-file";
import type { ApprovalMode } from "@kobe/protocol";
import { and, connectors, eq, teamConnectors, teamModels, type KobeTx } from "@kobe/db";
import type { ResolveInput } from "../resolver/resolve.js";

/**
 * Run-start inputs of the effective-config resolver (KOBE-76, 47b), gathered inside `withTeam()`.
 * Until the tickets that own them land, some inputs are fixed: no user-connected connectors
 * (KOBE-61, user decision: an agent's connectors are left out with `not_user_connected`), no
 * skill lists and no personal-skills switch (KOBE-78/80), an empty blocklist (KOBE-81).
 */
export interface TeamResolverFacts {
  readonly models: ResolveInput["team"]["models"];
  /** Active connectors the team enabled, by name, with their ids. */
  readonly connectors: readonly { readonly id: string; readonly name: string }[];
}

/** The team's enabled models and connectors (RLS: inside `withTeam`). */
export async function loadTeamFacts(tx: KobeTx, teamId: string): Promise<TeamResolverFacts> {
  const models = await tx
    .select({ alias: teamModels.alias, isDefault: teamModels.isDefault })
    .from(teamModels)
    .where(eq(teamModels.teamId, teamId));
  const enabled = await tx
    .select({ id: connectors.id, name: connectors.name })
    .from(teamConnectors)
    .innerJoin(connectors, eq(connectors.id, teamConnectors.connectorId))
    .where(and(eq(teamConnectors.teamId, teamId), eq(connectors.status, "active")));
  return { models, connectors: enabled };
}

export function buildResolveInput(args: {
  readonly frontmatter: AgentFrontmatter;
  /** The version's approval mode as frozen at publish (never loosened by a lowered floor). */
  readonly versionMode: ApprovalMode;
  readonly floor: ApprovalMode;
  readonly team: TeamResolverFacts;
}): ResolveInput {
  const { frontmatter, team } = args;
  return {
    agent: {
      modelAlias: frontmatter.model ?? null,
      approvalMode: args.versionMode,
      skills: [],
      exclusiveSkills: agentSkills(frontmatter).exclusive,
      connectors: frontmatter.connectors ?? [],
    },
    team: {
      models: team.models,
      connectors: team.connectors.map((c) => c.name),
      personalSkillsDisabled: false,
    },
    user: { skills: [], connectedConnectors: [] },
    approvalFloor: args.floor,
    blockedHashes: [],
  };
}
