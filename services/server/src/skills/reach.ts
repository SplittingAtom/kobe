import { agentSkills, type AgentFrontmatter } from "@kobe/agent-file";
import {
  and,
  eq,
  inArray,
  isNull,
  siteAgents,
  siteAgentVersions,
  teamAgents,
  teamAgentVersions,
  teamSkills,
  withTeam,
  type KobeDb,
  type KobeTx,
  type TeamRole,
} from "@kobe/db";
import { agentAccess, type AgentScope } from "../agents/access.js";
import { siteVisibleTo } from "../agents/versions.js";
import { recordAudit } from "../audit/record.js";
import { approvedTeamSkills } from "./review.js";

/**
 * Which agents a team skill reaches (KOBE-297). Runs get a team skill when their agent's current
 * version names it, or, with "Offer to all agents" on and an approved version, when the agent is
 * not exclusive (resolver/resolve.ts). Listed here: the team's agents, the gallery and the
 * caller's own personal agents (nobody else's exist for them), not archived. `canEdit` marks the
 * team agents the caller may change, for "Add to agent…".
 */

export interface ReachAgent {
  readonly id: string;
  readonly scope: AgentScope;
  readonly slug: string;
  readonly name: string;
  /** How its runs get the skill now: named by the current version, by the offer, or not at all. */
  readonly via: "named" | "offer" | null;
  readonly exclusive: boolean;
  /** The draft names the skill (it reaches runs once published). */
  readonly inDraft: boolean;
  readonly canEdit: boolean;
}

export interface SkillReach {
  readonly offerToAll: boolean;
  /** An approved version exists: neither naming nor the offer gives runs a skill without one. */
  readonly approved: boolean;
  readonly agents: readonly ReachAgent[];
}

interface AgentRow {
  readonly id: string;
  readonly scope: AgentScope;
  readonly ownerUserId: string | null;
  readonly slug: string;
  readonly draft: Record<string, unknown>;
  readonly current: Record<string, unknown> | undefined;
}

const skillsOf = (frontmatter: Record<string, unknown> | undefined) =>
  frontmatter === undefined
    ? { names: [] as string[], exclusive: false }
    : agentSkills(frontmatter as AgentFrontmatter);

async function teamAgentRows(tx: KobeTx, teamId: string): Promise<AgentRow[]> {
  const rows = await tx
    .select({
      id: teamAgents.id,
      ownerUserId: teamAgents.ownerUserId,
      slug: teamAgents.slug,
      draft: teamAgents.frontmatter,
      current: teamAgentVersions.frontmatter,
    })
    .from(teamAgents)
    .leftJoin(
      teamAgentVersions,
      and(
        eq(teamAgentVersions.teamId, teamAgents.teamId),
        eq(teamAgentVersions.agentId, teamAgents.id),
        eq(teamAgentVersions.version, teamAgents.currentVersion),
      ),
    )
    .where(and(eq(teamAgents.teamId, teamId), isNull(teamAgents.archivedAt)));
  return rows.map((r) => ({ ...r, scope: "team" as const, current: r.current ?? undefined }));
}

async function siteAgentRows(tx: KobeTx, userId: string): Promise<AgentRow[]> {
  const rows = await tx
    .select({
      id: siteAgents.id,
      scope: siteAgents.scope,
      ownerUserId: siteAgents.ownerUserId,
      slug: siteAgents.slug,
      draft: siteAgents.frontmatter,
      current: siteAgentVersions.frontmatter,
    })
    .from(siteAgents)
    .leftJoin(
      siteAgentVersions,
      and(
        eq(siteAgentVersions.agentId, siteAgents.id),
        eq(siteAgentVersions.version, siteAgents.currentVersion),
      ),
    )
    .where(and(siteVisibleTo(userId), isNull(siteAgents.archivedAt)));
  return rows.map((r) => ({ ...r, current: r.current ?? undefined }));
}

function reachOf(
  row: AgentRow,
  slug: string,
  offered: boolean,
  actor: { userId: string; role: TeamRole },
): ReachAgent {
  const current = skillsOf(row.current);
  const draft = skillsOf(row.draft);
  const named = current.names.includes(slug);
  const name = (row.current ?? row.draft).name;
  return {
    id: row.id,
    scope: row.scope,
    slug: row.slug,
    name: typeof name === "string" ? name : row.slug,
    via: named
      ? "named"
      : offered && row.current !== undefined && !current.exclusive
        ? "offer"
        : null,
    exclusive: (row.current === undefined ? draft : current).exclusive,
    inDraft: draft.names.includes(slug),
    canEdit:
      row.scope === "team" &&
      agentAccess(actor, { scope: row.scope, ownerUserId: row.ownerUserId }).edit,
  };
}

/** The reach of the team skill `skillId` (null: no such team skill). */
export function skillReach(
  db: KobeDb,
  viewer: { teamId: string; userId: string; role: TeamRole },
  skillId: string,
): Promise<SkillReach | null> {
  return withTeam(db, viewer.teamId, async (tx) => {
    const [skill] = await tx
      .select({ slug: teamSkills.slug, offerToAll: teamSkills.offerToAll })
      .from(teamSkills)
      .where(and(eq(teamSkills.teamId, viewer.teamId), eq(teamSkills.id, skillId)));
    if (!skill) return null;
    const approved = (await approvedTeamSkills(tx, viewer.teamId, [skill.slug])).length > 0;
    const rows = [
      ...(await teamAgentRows(tx, viewer.teamId)),
      ...(await siteAgentRows(tx, viewer.userId)),
    ];
    const offered = skill.offerToAll && approved;
    const agents = rows
      .map((r) => reachOf(r, skill.slug, offered, viewer))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { offerToAll: skill.offerToAll, approved, agents };
  });
}

/** Turns "Offer to all agents" on or off; audits a real change. Null: no such team skill. */
export function setOfferToAll(
  db: KobeDb,
  teamId: string,
  skillId: string,
  offerToAll: boolean,
): Promise<boolean | null> {
  return withTeam(db, teamId, async (tx) => {
    const [skill] = await tx
      .select({ slug: teamSkills.slug, offerToAll: teamSkills.offerToAll })
      .from(teamSkills)
      .where(and(eq(teamSkills.teamId, teamId), eq(teamSkills.id, skillId)))
      .for("update");
    if (!skill) return null;
    if (skill.offerToAll === offerToAll) return offerToAll;
    await tx
      .update(teamSkills)
      .set({ offerToAll })
      .where(and(eq(teamSkills.teamId, teamId), eq(teamSkills.id, skillId)));
    await recordAudit(tx, {
      action: "skill.offer.changed",
      teamId,
      target: { skillId, slug: skill.slug, offerToAll },
    });
    return offerToAll;
  });
}

/** Names of agents by id, for usage rows (only agents the viewer may see get a name). */
export async function agentNames(
  tx: KobeTx,
  viewer: { teamId: string; userId: string },
  ids: readonly string[],
): Promise<Map<string, { scope: AgentScope; name: string }>> {
  const out = new Map<string, { scope: AgentScope; name: string }>();
  if (ids.length === 0) return out;
  const team = await tx
    .select({ id: teamAgents.id, slug: teamAgents.slug, frontmatter: teamAgents.frontmatter })
    .from(teamAgents)
    .where(and(eq(teamAgents.teamId, viewer.teamId), inArray(teamAgents.id, [...ids])));
  const site = await tx
    .select({
      id: siteAgents.id,
      scope: siteAgents.scope,
      slug: siteAgents.slug,
      frontmatter: siteAgents.frontmatter,
    })
    .from(siteAgents)
    .where(and(inArray(siteAgents.id, [...ids]), siteVisibleTo(viewer.userId)));
  for (const r of [...team.map((t) => ({ ...t, scope: "team" as const })), ...site]) {
    const name = r.frontmatter.name;
    out.set(r.id, { scope: r.scope, name: typeof name === "string" ? name : r.slug });
  }
  return out;
}
