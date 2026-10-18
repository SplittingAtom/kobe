import { agentConnectors, agentSkills, type AgentFrontmatter } from "@kobe/agent-file";
import { isBuiltinSkillName, type ApprovalMode } from "@kobe/protocol";
import {
  and,
  connectors,
  eq,
  sql,
  teamConnectors,
  teamModels,
  teamSkills,
  type KobeTx,
} from "@kobe/db";
import type { ResolveInput, SkillOmission, SkillRef } from "../resolver/resolve.js";
import { blockedAmong } from "../skills/blocklist.js";
import { approvedTeamSkills, personalSkillUsage, teamSkillStates } from "../skills/review.js";
import { readPersonalSkillsDisabled } from "../skills/settings.js";
import { loadCatalogFacts } from "./catalog-facts.js";

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

/** The skills of a run in SK27 order (KOBE-315): Required, named, installs and adds, personal. */
export interface SkillFacts {
  readonly agent: readonly SkillRef[];
  /** Named catalog skills at the team install's pin (KOBE-315). */
  readonly agentCatalog: readonly SkillRef[];
  /** Named catalog skills left out (`not_installed`, `revoked`, `suspended`). */
  readonly agentOmissions: readonly SkillOmission[];
  /** Built-in names the agent lists (KOBE-88): site-provided, never looked up or reviewed. */
  readonly agentBuiltin: readonly string[];
  readonly user: readonly SkillRef[];
  /** Agent skill names with no approved team version (KOBE-99). */
  readonly agentUnapproved: readonly string[];
  /** Agent skill names whose approved version a rescan suspended (KOBE-313). */
  readonly agentSuspended: readonly string[];
  /** Personal skills blocked for lack of this team's approval (KOBE-99). */
  readonly userUnapproved: readonly string[];
  /** Personal skills a rescan suspended, pending this team's review (KOBE-313). */
  readonly userSuspended: readonly string[];
  /** Step 1: Required team skills, then Required installs. */
  readonly required: readonly SkillRef[];
  readonly requiredOmissions: readonly SkillOmission[];
  /**
   * Step 3: team skills On by default (KOBE-297's "Offer to all agents") the member did not turn
   * off and Available ones they turned on, then catalog installs and adds likewise.
   */
  readonly offered: readonly SkillRef[];
  readonly offeredOmissions: readonly SkillOmission[];
  /** Hashes among the lists that the site blocklist holds (read at this run start, KOBE-81). */
  readonly blockedHashes: readonly string[];
}

/** Slugs of the team skills set to "Offer to all agents" (KOBE-297; RLS: inside `withTeam`). */
export async function offeredSkillNames(tx: KobeTx, teamId: string): Promise<string[]> {
  const rows = await tx
    .select({ slug: teamSkills.slug })
    .from(teamSkills)
    .where(and(eq(teamSkills.teamId, teamId), eq(teamSkills.offerToAll, true)));
  return rows.map((r) => r.slug);
}

/**
 * The team's own skills by access mode for one member (KOBE-315, SK25): Required ones, and the
 * ones on for this member (On by default unless turned off, Available if turned on). Archived
 * skills are hidden from new use (SK33) and only resolve when an agent names them. "Offer to all
 * agents" (KOBE-297) reads as On by default even where only `offer_to_all` was written (a
 * rollback across KOBE-308), until KOBE-316 retires it.
 */
async function teamSkillAccess(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<{ required: string[]; on: string[]; local: Set<string> }> {
  const { rows } = await tx.execute<{
    slug: string;
    access: string;
    archived: boolean;
    mine: boolean | null;
  }>(sql`
    SELECT s.slug,
      CASE WHEN s.offer_to_all AND s.access = 'available' THEN 'default_on' ELSE s.access::text END
        AS access,
      s.archived_at IS NOT NULL AS archived, e.enabled AS mine
    FROM team_skills s
    LEFT JOIN member_skill_enablements e
      ON e.team_id = s.team_id AND e.team_skill_id = s.id AND e.user_id = ${userId}
    WHERE s.team_id = ${teamId}`);
  const live = rows.filter((r) => !r.archived);
  return {
    required: live.filter((r) => r.access === "required").map((r) => r.slug),
    on: live
      .filter(
        (r) =>
          (r.access === "default_on" && r.mine !== false) ||
          (r.access === "available" && r.mine === true),
      )
      .map((r) => r.slug),
    local: new Set(rows.map((r) => r.slug)),
  };
}

/** Which of `names` are catalog skills (registry_skills is site-wide). */
async function catalogNamesAmong(tx: KobeTx, names: readonly string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const { rows } = await tx.execute<{ name: string }>(sql`
    SELECT name FROM registry_skills WHERE name IN (${sql.join(
      names.map((n) => sql`${n}`),
      sql`, `,
    )})`);
  return rows.map((r) => r.name);
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
  const listed = [...new Set(args.agentSkillNames.filter((n) => !isBuiltinSkillName(n)))];
  const access = await teamSkillAccess(tx, args.teamId, args.userId);
  // A name the team has a skill of is the team's own (the name-clash rule keeps installs from
  // taking it); otherwise a catalog skill of that name resolves through the team's install.
  const namedCatalog = await catalogNamesAmong(
    tx,
    listed.filter((n) => !access.local.has(n)),
  );
  const teamNames = listed.filter((n) => !namedCatalog.includes(n));
  // One transaction, one connection: these reads run one after the other.
  const named = await teamSkillStates(tx, args.teamId, teamNames);
  // In the agent's own order: which named skills a full run keeps does not depend on a query plan.
  const agent = named.approved
    .map(fromTeam)
    .sort((a, b) => teamNames.indexOf(a.name) - teamNames.indexOf(b.name));
  const user = await personalSkillUsage(tx, {
    teamId: args.teamId,
    userId: args.userId,
    ensureRows: !args.personalSkillsDisabled,
  });
  const usable = user.usable.map((s): SkillRef => ({ ...s, source: "personal" }));
  const catalog = await loadCatalogFacts(tx, {
    teamId: args.teamId,
    userId: args.userId,
    namedCatalog,
  });
  // Only approved versions, like named team skills: an access mode never widens what review
  // allows. Sorted by name: which skills a full run leaves out (`skill_limit`) is stable.
  const approvedSorted = async (names: readonly string[]) =>
    (await approvedTeamSkills(tx, args.teamId, names)).map(fromTeam).sort(byName);
  const required = [...(await approvedSorted(access.required)), ...catalog.required];
  const offered = [...(await approvedSorted(access.on)), ...catalog.offered];
  const decided = new Set([...agent.map((s) => s.name), ...named.suspended]);
  const all = [...required, ...agent, ...catalog.named, ...offered, ...usable];
  // Read in the run-start transaction itself, so a hash blocked a moment ago is already dropped.
  const blockedHashes = await blockedAmong(
    tx,
    all.flatMap((s) => [s.hash, ...(s.aliases ?? [])]),
  );
  return {
    agent,
    agentCatalog: catalog.named,
    agentOmissions: catalog.namedOmissions,
    agentBuiltin,
    user: usable,
    required,
    requiredOmissions: catalog.requiredOmissions,
    offered,
    offeredOmissions: catalog.offeredOmissions,
    blockedHashes,
    agentUnapproved: teamNames.filter((n) => !decided.has(n)),
    agentSuspended: named.suspended,
    userUnapproved: user.blocked,
    userSuspended: user.suspended,
  };
}

const byName = (a: SkillRef, b: SkillRef) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const fromTeam = (s: { name: string; hash: string; semver?: string }): SkillRef => ({
  ...s,
  source: "team",
});

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
  const connectors = agentConnectors(frontmatter);
  return {
    agent: {
      modelAlias: frontmatter.model ?? null,
      approvalMode: args.versionMode,
      skills: args.skills.agent,
      catalogSkills: args.skills.agentCatalog,
      skillOmissions: args.skills.agentOmissions,
      builtinSkills: args.skills.agentBuiltin,
      unapprovedSkills: args.skills.agentUnapproved,
      suspendedSkills: args.skills.agentSuspended,
      exclusiveSkills: agentSkills(frontmatter).exclusive,
      // `connectors: all` (KOBE-254) stays a request: the resolver intersects it like a list.
      connectors: connectors.all ? "all" : connectors.names,
    },
    team: {
      models: team.models,
      connectors: team.connectors.map((c) => c.name),
      personalSkillsDisabled: team.personalSkillsDisabled,
      requiredSkills: args.skills.required,
      requiredOmissions: args.skills.requiredOmissions,
      offeredSkills: args.skills.offered,
      offeredOmissions: args.skills.offeredOmissions,
    },
    user: {
      skills: args.skills.user,
      unapprovedSkills: args.skills.userUnapproved,
      suspendedSkills: args.skills.userSuspended,
      connectedConnectors: args.connectedConnectors,
    },
    approvalFloor: args.floor,
    blockedHashes: args.skills.blockedHashes,
  };
}
