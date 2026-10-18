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
import { setTeamSkillAccess } from "./access.js";
import { approvedTeamSkills } from "./review.js";

/**
 * Which agents a team skill reaches (KOBE-297, KOBE-316). Runs get a team skill when their agent's
 * current version names it, or, with an approved version, when it is On by default and the agent
 * is not exclusive, or when it is Required (every agent; resolver/resolve.ts). An On by default
 * skill still reaches only members who haven't turned it off; an Available one only those who
 * turned it on. Listed here: the team's agents, the gallery and the
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

type Offer = "none" | "default" | "required";

export interface SkillReach {
  readonly offerToAll: boolean;
  /** The access mode (KOBE-316): On by default and Required reach agents without naming. */
  readonly access: "available" | "default_on" | "required" | "hidden";
  /** An approved version exists: neither naming nor the offer gives runs a skill without one. */
  readonly approved: boolean;
  readonly agents: readonly ReachAgent[];
}

interface AgentRow {
  readonly id: string;
  readonly scope: AgentScope;
  readonly ownerUserId: string | null;
  readonly slug: string;
  readonly status: string;
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
      status: teamAgents.status,
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
      status: siteAgents.status,
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

const nameOf = (frontmatter: Record<string, unknown>, slug: string) =>
  typeof frontmatter.name === "string" ? frontmatter.name : slug;

/**
 * One agent's row, as far as the caller may see it. Someone who may read the definition
 * (`agentAccess`: builders for team agents, everyone for the gallery and their own) gets how it
 * names the skill, its exclusivity and its draft; anyone else only published, active agents, by
 * their published name, reached or not by the offer (L1 of the KOBE-297 review).
 */
function reachOf(
  row: AgentRow,
  slug: string,
  offer: Offer,
  actor: { userId: string; role: TeamRole },
): ReachAgent | undefined {
  const access = agentAccess(actor, { scope: row.scope, ownerUserId: row.ownerUserId });
  const current = skillsOf(row.current);
  // On by default reaches agents that aren't exclusive; Required reaches every agent (SK27).
  const offered = offer === "required" || (offer === "default" && !current.exclusive);
  if (!access.readDefinition) {
    if (row.current === undefined || row.status !== "active") return undefined;
    return {
      id: row.id,
      scope: row.scope,
      slug: row.slug,
      name: nameOf(row.current, row.slug),
      via: offered ? "offer" : null,
      exclusive: false,
      inDraft: false,
      canEdit: false,
    };
  }
  const draft = skillsOf(row.draft);
  return {
    id: row.id,
    scope: row.scope,
    slug: row.slug,
    name: nameOf(row.current ?? row.draft, row.slug),
    via: current.names.includes(slug)
      ? "named"
      : offered && row.current !== undefined
        ? "offer"
        : null,
    exclusive: (row.current === undefined ? draft : current).exclusive,
    inDraft: draft.names.includes(slug),
    canEdit: row.scope === "team" && access.edit,
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
      .select({
        slug: teamSkills.slug,
        offerToAll: teamSkills.offerToAll,
        access: teamSkills.access,
      })
      .from(teamSkills)
      .where(and(eq(teamSkills.teamId, viewer.teamId), eq(teamSkills.id, skillId)));
    if (!skill) return null;
    // "Offer to all agents" written alone (a rollback across KOBE-308) reads as On by default.
    const mode = skill.offerToAll && skill.access === "available" ? "default_on" : skill.access;
    const approved = (await approvedTeamSkills(tx, viewer.teamId, [skill.slug])).length > 0;
    const rows = [
      ...(await teamAgentRows(tx, viewer.teamId)),
      ...(await siteAgentRows(tx, viewer.userId)),
    ];
    const offer: Offer = !approved
      ? "none"
      : mode === "required"
        ? "required"
        : mode === "default_on"
          ? "default"
          : "none";
    const agents = rows
      .flatMap((r) => reachOf(r, skill.slug, offer, viewer) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { offerToAll: skill.offerToAll, access: mode, approved, agents };
  });
}

export { MAX_OFFERED_SKILLS } from "./access.js";

export type OfferResult =
  | { readonly ok: true; readonly offerToAll: boolean }
  | { readonly ok: false; readonly error: "not_found" | "offer_limit" | "access_mode" };

/**
 * The legacy "Offer to all agents" (KOBE-297), kept for older pages since KOBE-316: on is On by
 * default, off is Available, through {@link setTeamSkillAccess} (the same cap and the
 * `skill.access.changed` audit, plus `skill.offer.changed`). A Required or Hidden skill is refused
 * (`access_mode`): the old toggle can't express them, and must never silently change them (review
 * S1 of KOBE-316).
 */
export async function setOfferToAll(
  db: KobeDb,
  teamId: string,
  skillId: string,
  offerToAll: boolean,
): Promise<OfferResult> {
  const result = await setTeamSkillAccess(db, {
    teamId,
    skillId,
    access: offerToAll ? "default_on" : "available",
    mayRequire: false,
    onlyFrom: ["available", "default_on"],
    offerAudit: true,
  });
  if (result.ok) return { ok: true, offerToAll };
  if (result.code === "forbidden") return { ok: false, error: "access_mode" };
  return { ok: false, error: result.code };
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
