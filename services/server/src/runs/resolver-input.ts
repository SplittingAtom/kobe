import { agentSkills, type AgentFrontmatter } from "@kobe/agent-file";
import type { ApprovalMode } from "@kobe/protocol";
import { and, connectors, eq, teamConnectors, teamModels, type KobeTx } from "@kobe/db";
import type { ResolveInput, SkillRef } from "../resolver/resolve.js";
import { approvedTeamSkills } from "../skills/review.js";
import { personalSkillRefs, readPersonalSkillsDisabled } from "../skills/settings.js";

/**
 * Run-start inputs of the effective-config resolver (KOBE-76, 47b), gathered inside `withTeam()`.
 * Until the tickets that own them land, some inputs are fixed: no user-connected connectors
 * (KOBE-61, user decision: an agent's connectors are left out with `not_user_connected`) and an
 * empty blocklist (KOBE-81). Skills (KOBE-78/80): the agent's named team skills resolve to their
 * newest team-admin-approved version (an unreviewed, pending or rejected one is unusable and
 * dropped), the user's personal skills to their latest versions, and the team's switch
 * `personalSkillsDisabled` is read here.
 */
export interface TeamResolverFacts {
  readonly models: ResolveInput["team"]["models"];
  /** Active connectors the team enabled, by name, with their ids. */
  readonly connectors: readonly { readonly id: string; readonly name: string }[];
  readonly personalSkillsDisabled: boolean;
}

/** The skills of a run: the agent's approved team skills and the user's personal ones. */
export interface SkillFacts {
  readonly agent: readonly SkillRef[];
  readonly user: readonly SkillRef[];
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
  return {
    models,
    connectors: enabled,
    personalSkillsDisabled: await readPersonalSkillsDisabled(tx, teamId),
  };
}

/**
 * Skill refs for run start (inside `withTeam`). `agentSkillNames` are the names in the agent's
 * frontmatter; only approved team versions come back. Personal skills are loaded even when the
 * team switch is on: the resolver omits them with a visible `team_disabled` notice.
 */
export async function loadSkillFacts(
  tx: KobeTx,
  args: { teamId: string; userId: string; agentSkillNames: readonly string[] },
): Promise<SkillFacts> {
  const [agent, user] = await Promise.all([
    approvedTeamSkills(tx, args.teamId, args.agentSkillNames),
    personalSkillRefs(tx, args.userId),
  ]);
  return { agent, user };
}

export function buildResolveInput(args: {
  readonly frontmatter: AgentFrontmatter;
  /** The version's approval mode as frozen at publish (never loosened by a lowered floor). */
  readonly versionMode: ApprovalMode;
  readonly floor: ApprovalMode;
  readonly team: TeamResolverFacts;
  readonly skills: SkillFacts;
}): ResolveInput {
  const { frontmatter, team } = args;
  return {
    agent: {
      modelAlias: frontmatter.model ?? null,
      approvalMode: args.versionMode,
      skills: args.skills.agent,
      exclusiveSkills: agentSkills(frontmatter).exclusive,
      connectors: frontmatter.connectors ?? [],
    },
    team: {
      models: team.models,
      connectors: team.connectors.map((c) => c.name),
      personalSkillsDisabled: team.personalSkillsDisabled,
    },
    user: {
      skills: args.skills.user,
      connectedConnectors: [], // TODO(KOBE-61): the user's connected connectors
    },
    approvalFloor: args.floor,
    blockedHashes: [], // TODO(KOBE-81): skill_blocklist hashes
  };
}
