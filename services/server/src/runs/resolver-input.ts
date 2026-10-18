import { agentConnectors, agentSkills, type AgentFrontmatter } from "@kobe/agent-file";
import { PUBLISHED_VERSION_STATES, isKobeSkillName, type ApprovalMode } from "@kobe/protocol";
import { and, connectors, eq, sql, teamConnectors, teamModels, type KobeTx } from "@kobe/db";
import type { ResolveInput, SkillOmission, SkillRef } from "../resolver/resolve.js";
import { blockedAmong } from "../skills/blocklist.js";
import { personalSkillUsage, teamSkillStates } from "../skills/review.js";
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
): Promise<{ required: string[]; on: string[]; local: Set<string>; archived: Set<string> }> {
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
    archived: new Set(rows.filter((r) => r.archived).map((r) => r.slug)),
  };
}

const inList = (names: readonly string[]) =>
  sql.join(
    names.map((n) => sql`${n}`),
    sql`, `,
  );

/**
 * Which of `names` are catalog skills (registry_skills is site-wide): only skills with a published
 * version, so a name that exists only as another team's submission in review is not revealed
 * (review N7: it reads as `not_approved`, like any unknown name).
 */
async function catalogNamesAmong(tx: KobeTx, names: readonly string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const { rows } = await tx.execute<{ name: string }>(sql`
    SELECT s.name FROM registry_skills s
    WHERE s.name IN (${inList(names)}) AND EXISTS (
      SELECT 1 FROM registry_versions v
      WHERE v.skill_id = s.id AND v.state::text IN (${inList(PUBLISHED_VERSION_STATES)}))`);
  return rows.map((r) => r.name);
}

/** Which of `names` the team installed from the catalog (RLS: inside `withTeam`). */
async function installedNamesAmong(
  tx: KobeTx,
  teamId: string,
  names: readonly string[],
): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const { rows } = await tx.execute<{ name: string }>(sql`
    SELECT s.name FROM team_skill_installs i JOIN registry_skills s ON s.id = i.skill_id
    WHERE i.team_id = ${teamId} AND s.name IN (${inList(names)})`);
  return new Set(rows.map((r) => r.name));
}

/**
 * Which named skills resolve through the catalog (SK27, review S4). A name the team has no skill
 * of is the catalog's. A name both have is the team's own, unless the team installed the catalog
 * skill and its own skill is archived or has never been approved: a draft never hides an
 * installed, Site-reviewed skill, and archiving a skill to install the catalog one (the name-clash
 * rule) hands the name over. A Kobe skill's name is always the catalog's (KOBE-317, SK24): it was
 * reserved for the built-in before, so an agent naming `pdf` keeps getting Kobe's.
 */
async function catalogNamed(
  tx: KobeTx,
  teamId: string,
  listed: readonly string[],
  access: { local: Set<string>; archived: Set<string> },
  localStates: { approved: readonly { name: string }[]; suspended: readonly string[] },
): Promise<string[]> {
  const found = new Set(await catalogNamesAmong(tx, listed));
  // In the agent's own order, like its local skills.
  const catalog = listed.filter((n) => found.has(n));
  const installed = await installedNamesAmong(
    tx,
    teamId,
    catalog.filter((n) => access.local.has(n)),
  );
  const reviewed = new Set([...localStates.approved.map((s) => s.name), ...localStates.suspended]);
  return catalog.filter(
    (n) =>
      isKobeSkillName(n) ||
      !access.local.has(n) ||
      (installed.has(n) && (access.archived.has(n) || !reviewed.has(n))),
  );
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
  // Kobe's skills (the former built-ins, KOBE-317) are catalog names like any other: they resolve
  // through the team's install (or the Default install still on its way, catalog-facts.ts).
  const listed = [...new Set(args.agentSkillNames)];
  const access = await teamSkillAccess(tx, args.teamId, args.userId);
  // One transaction, one connection: these reads run one after the other.
  const localStates = await teamSkillStates(
    tx,
    args.teamId,
    listed.filter((n) => access.local.has(n) && !isKobeSkillName(n)),
  );
  const namedCatalog = await catalogNamed(tx, args.teamId, listed, access, localStates);
  const teamNames = listed.filter((n) => !namedCatalog.includes(n));
  const named = {
    approved: localStates.approved.filter((s) => teamNames.includes(s.name)),
    suspended: localStates.suspended.filter((n) => teamNames.includes(n)),
  };
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
  const requiredLocal = await localByAccess(tx, args.teamId, access.required, true);
  const offeredLocal = await localByAccess(tx, args.teamId, access.on, false);
  const required = [...requiredLocal.refs, ...catalog.required];
  const offered = [...offeredLocal.refs, ...catalog.offered];
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
    user: usable,
    required,
    requiredOmissions: [...requiredLocal.omissions, ...catalog.requiredOmissions],
    offered,
    offeredOmissions: [...offeredLocal.omissions, ...catalog.offeredOmissions],
    blockedHashes,
    agentUnapproved: teamNames.filter((n) => !decided.has(n)),
    agentSuspended: named.suspended,
    userUnapproved: user.blocked,
    userSuspended: user.suspended,
  };
}

/**
 * Step 1 alone, for a run with no agent (the site default agent, review S6): the team's Required
 * skills and Required installs load "for each run" (SK27), and their omissions show. Nothing else:
 * such runs carry no named, offered or personal skills, as before.
 */
export async function loadRequiredSkillFacts(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<Pick<SkillFacts, "required" | "requiredOmissions" | "blockedHashes">> {
  const access = await teamSkillAccess(tx, teamId, userId);
  const local = await localByAccess(tx, teamId, access.required, true);
  const catalog = await loadCatalogFacts(tx, { teamId, userId, namedCatalog: [] });
  const required = [...local.refs, ...catalog.required];
  return {
    required,
    requiredOmissions: [...local.omissions, ...catalog.requiredOmissions],
    blockedHashes: await blockedAmong(
      tx,
      required.flatMap((s) => [s.hash, ...(s.aliases ?? [])]),
    ),
  };
}

const byName = (a: SkillRef, b: SkillRef) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Team skills by access mode at their newest approved version, sorted by name (which skills a
 * full run leaves out, `skill_limit`, is stable). Only approved versions, like named team skills:
 * an access mode never widens what review allows. A suspended one is reported `suspended`
 * (review N1); a Required one with no approved version is reported `not_approved`, so it holds
 * its name too (review S2).
 */
async function localByAccess(
  tx: KobeTx,
  teamId: string,
  names: readonly string[],
  required: boolean,
): Promise<{ refs: SkillRef[]; omissions: SkillOmission[] }> {
  const states = await teamSkillStates(tx, teamId, names);
  const suspended = new Set(states.suspended);
  const approved = new Set(states.approved.map((s) => s.name));
  const omissions = [...names]
    .sort()
    .flatMap((name): SkillOmission[] =>
      suspended.has(name)
        ? [{ name, reason: "suspended" }]
        : required && !approved.has(name)
          ? [{ name, reason: "not_approved" }]
          : [],
    );
  return { refs: states.approved.map(fromTeam).sort(byName), omissions };
}

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
