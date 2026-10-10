import { agentSkills, type AgentFrontmatter } from "@kobe/agent-file";
import { isBuiltinSkillName, type ApprovalMode } from "@kobe/protocol";
import { and, connectors, eq, teamConnectors, teamModels, type KobeTx } from "@kobe/db";
import type { ResolveInput, SkillRef } from "../resolver/resolve.js";
import { blockedAmong } from "../skills/blocklist.js";
import { approvedTeamSkills, personalSkillUsage } from "../skills/review.js";
import { readPersonalSkillsDisabled } from "../skills/settings.js";

/**
 * Run-start inputs of the effective-config resolver (KOBE-76, 47b), gathered inside `withTeam()`.
 * A connector is user-connected when the user holds a usable grant for it (KOBE-111, run-mcp.ts);
 * the others are left out with `not_user_connected`. Skills (KOBE-78/80): the agent's named team skills resolve to their
 * newest team-admin-approved version (an unreviewed, pending or rejected one is unusable and
 * dropped), the user's personal skills to their latest versions (a flagged or unscanned one only once this team approved it), and the team's switch
 * `personalSkillsDisabled` is read here. Blocklisted hashes (KOBE-81) are read from the table at
 * every run start, never cached; the resolver then omits those skills with reason `blocklisted`.
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
  /** Built-in names the agent lists (KOBE-88): install-provided, never looked up or reviewed. */
  readonly agentBuiltin: readonly string[];
  readonly user: readonly SkillRef[];
  /** Agent skill names with no approved team version (KOBE-99). */
  readonly agentUnapproved: readonly string[];
  /** Personal skills blocked for lack of this team's approval (KOBE-99). */
  readonly userUnapproved: readonly string[];
  /** Hashes among the two lists that the install blocklist holds (read at this run start, KOBE-81). */
  readonly blockedHashes: readonly string[];
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
  args: {
    teamId: string;
    userId: string;
    agentSkillNames: readonly string[];
    /** The team switch: personal skills are then not even queued for review. */
    personalSkillsDisabled: boolean;
  },
): Promise<SkillFacts> {
  // Built-in names are reserved (KOBE-88): they come from the image, not from a team skill of that
  // name, so they are neither looked up nor reported as unapproved.
  const agentBuiltin = [...new Set(args.agentSkillNames.filter(isBuiltinSkillName))];
  const teamNames = args.agentSkillNames.filter((n) => !isBuiltinSkillName(n));
  const [agent, user] = await Promise.all([
    approvedTeamSkills(tx, args.teamId, teamNames),
    personalSkillUsage(tx, {
      teamId: args.teamId,
      userId: args.userId,
      ensureRows: !args.personalSkillsDisabled,
    }),
  ]);
  const approved = new Set(agent.map((s) => s.name));
  // Read in the run-start transaction itself, so a hash blocked a moment ago is already dropped.
  const blockedHashes = await blockedAmong(
    tx,
    [...agent, ...user.usable].map((s) => s.hash),
  );
  return {
    agent,
    agentBuiltin,
    user: user.usable,
    blockedHashes,
    agentUnapproved: [...new Set(teamNames)].filter((n) => !approved.has(n)),
    userUnapproved: user.blocked,
  };
}

export function buildResolveInput(args: {
  readonly frontmatter: AgentFrontmatter;
  /** The version's approval mode as frozen at publish (never loosened by a lowered floor). */
  readonly versionMode: ApprovalMode;
  readonly floor: ApprovalMode;
  readonly team: TeamResolverFacts;
  readonly skills: SkillFacts;
  /** Names of the team connectors the run's user can use (run-mcp.ts `connectedConnectorNames`). */
  readonly connectedConnectors: readonly string[];
}): ResolveInput {
  const { frontmatter, team } = args;
  return {
    agent: {
      modelAlias: frontmatter.model ?? null,
      approvalMode: args.versionMode,
      skills: args.skills.agent,
      builtinSkills: args.skills.agentBuiltin,
      unapprovedSkills: args.skills.agentUnapproved,
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
      unapprovedSkills: args.skills.userUnapproved,
      connectedConnectors: args.connectedConnectors,
    },
    approvalFloor: args.floor,
    blockedHashes: args.skills.blockedHashes,
  };
}
