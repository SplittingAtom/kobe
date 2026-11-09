import type { TeamRole } from "@kobe/db";
import { teamRoleAllows } from "../authz/permissions.js";

/**
 * Who may do what with an agent definition (spec D6, D8, D9, D19). Pure, so routes and tests
 * share one rulebook. The caller is a member of the active team with `role`.
 */

export type AgentScope = "personal" | "team" | "gallery";
/** Scopes a team member can create into; gallery agents are created by site admins. */
export type CreatableScope = Exclude<AgentScope, "gallery">;

export interface AgentRef {
  readonly scope: AgentScope;
  readonly ownerUserId: string | null;
}

export interface AgentActor {
  readonly userId: string;
  readonly role: TeamRole;
}

export interface AgentAccess {
  /** Listed and shown as a summary (name, description, icon, starters). */
  readonly see: boolean;
  /** Full definition (frontmatter + prompt) and export. */
  readonly readDefinition: boolean;
  /** Replace the draft, delete (or archive) the agent, unarchive it. */
  readonly edit: boolean;
  /** Publish the draft as a new version, or roll back to an older one (KOBE-46). */
  readonly publish: boolean;
  /** Suspend or reactivate (team agents, team admins). */
  readonly setStatus: boolean;
}

const NONE: AgentAccess = {
  see: false,
  readDefinition: false,
  edit: false,
  publish: false,
  setStatus: false,
};

export function agentAccess(actor: AgentActor, agent: AgentRef): AgentAccess {
  const { role } = actor;
  switch (agent.scope) {
    case "team": {
      const builder = teamRoleAllows(role, "team.agents.build");
      const mine = agent.ownerUserId === actor.userId || teamRoleAllows(role, "team.agents.manage");
      return {
        see: teamRoleAllows(role, "team.agents.use"),
        readDefinition: builder,
        edit: builder && mine,
        // D8: builders publish (their own agents), team admins publish any team agent.
        publish: teamRoleAllows(role, "team.agents.publish") && mine,
        setStatus: teamRoleAllows(role, "team.agents.suspend"),
      };
    }
    case "personal": {
      // Someone else's personal agent does not exist as far as the caller is concerned.
      if (agent.ownerUserId !== actor.userId) return NONE;
      const own = teamRoleAllows(role, "team.personal.create");
      return { see: true, readDefinition: true, edit: own, publish: own, setStatus: false };
    }
    case "gallery": {
      // Site-wide, admin-curated and read-only to teams; teams fork (D19).
      const use = teamRoleAllows(role, "team.agents.use");
      return { see: use, readDefinition: use, edit: false, publish: false, setStatus: false };
    }
  }
}

export function canCreateAgent(role: TeamRole, scope: CreatableScope): boolean {
  return teamRoleAllows(role, scope === "team" ? "team.agents.build" : "team.personal.create");
}

/**
 * How the caller reaches the agent they fork (KOBE-568, agents-roster AR8, §5): their own personal
 * agent, the active team's own agent, someone else's agent on the active team's roster or on the
 * site roster, or a gallery agent.
 */
export type ForkVia = "own" | "team_owned" | "team_entry" | "site_entry" | "gallery";

/**
 * Forking copies a definition into a new personal agent of the caller's (AR8): offered to anyone
 * who may read the definition from where they see it (§5: `build` for team-owned and team-assigned
 * agents, `use` for site-assigned and gallery agents, and the owner). Teams stay walls through
 * binding ({@link forkBinding}), not by refusing the copy.
 */
export function canForkAgent(actor: AgentActor, via: ForkVia): boolean {
  if (!teamRoleAllows(actor.role, "team.personal.create")) return false;
  switch (via) {
    case "own":
      return true;
    case "team_owned":
    case "team_entry":
      return teamRoleAllows(actor.role, "team.agents.build");
    case "site_entry":
    case "gallery":
      return teamRoleAllows(actor.role, "team.agents.use");
  }
}

/**
 * The team a fork is bound to (AR8): a fork of a bound agent keeps its binding (permanent, a copy
 * of a copy stays bound); a fork of team content (a team-owned agent or a team-assigned entry) is
 * bound to that team; gallery, site-assigned and unbound personal agents fork unbound.
 */
export function forkBinding(
  via: ForkVia,
  sourceBoundTeamId: string | null,
  activeTeamId: string,
): string | null {
  if (sourceBoundTeamId !== null) return sourceBoundTeamId;
  return via === "team_owned" || via === "team_entry" ? activeTeamId : null;
}

/**
 * Site admins (site.gallery.manage) see the gallery but change nothing through the API:
 * gallery agents come from definitions in the repo, seeded at install and upgrade (KOBE-87).
 */
export const GALLERY_ADMIN_ACCESS: AgentAccess = {
  see: true,
  readDefinition: true,
  edit: false,
  publish: false,
  setStatus: false,
};

// ── Roster rights (KOBE-566, spec agents-roster §5, AR6, AR7, §6.5) ───────────────────────────────

export type RosterTab = "personal" | "team" | "site";
export type RosterTarget = "team" | "site";
export type RosterEntryState = "proposed" | "active" | "removed" | "suspended";

/** The caller in the active team, and whether they are a site admin (`site.gallery.manage`). */
export interface RosterActor extends AgentActor {
  readonly teamId: string;
  readonly siteAdmin: boolean;
}

/** A site admin acting on the site roster, outside any team (`PUT /v1/site/agent-roster`). */
export interface SiteRosterActor {
  readonly userId: string;
  readonly siteAdmin: true;
}

/** What the rules need to know about an agent on a roster (ids and states only). */
export interface RosterSubject {
  readonly kind: "personal" | "team_owned" | "gallery";
  /** The owner of a personal agent, the creator of a team-owned one; null for gallery agents. */
  readonly ownerUserId: string | null;
  readonly boundTeamId: string | null;
  readonly published: boolean;
  readonly archived: boolean;
  /** A team-owned agent's own status is `suspended`. */
  readonly suspended: boolean;
  /** Its entry on the active team's roster, and on the site roster (null: none). */
  readonly teamEntry: RosterEntryState | null;
  readonly siteEntry: RosterEntryState | null;
  /** The active team suspended this site-wide agent (`team_agent_suspensions`). */
  readonly suspendedHere: boolean;
}

export interface RosterActions {
  readonly view: boolean;
  readonly viewDefinition: boolean;
  readonly edit: boolean;
  readonly fork: boolean;
  readonly assignTeam: "direct" | "propose" | null;
  readonly assignSite: "direct" | "propose" | null;
  readonly withdrawTeam: boolean;
  readonly withdrawSite: boolean;
  readonly decide: boolean;
  readonly remove: boolean;
  readonly pin: boolean;
  readonly suspendHere: boolean;
  readonly resumeHere: boolean;
  readonly suspendSiteWide: boolean;
  readonly resumeSiteWide: boolean;
  readonly adopt: boolean;
}

export type AssignError =
  | "forbidden"
  | "agent_archived"
  | "agent_bound_to_team"
  | "already_on_roster"
  | "agent_not_published";

export type AssignDecision =
  { ok: true; mode: "direct" | "propose" } | { ok: false; error: AssignError };

/** An entry that holds a place on its roster (anything but `removed`). */
export const liveEntry = (state: RosterEntryState | null): boolean =>
  state !== null && state !== "removed";
/** An assigned entry an admin can pin, remove or suspend (not a proposal). */
const assignedEntry = (state: RosterEntryState | null): boolean =>
  state === "active" || state === "suspended";

const isOwn = (actor: AgentActor, s: RosterSubject) =>
  s.kind === "personal" && s.ownerUserId === actor.userId;

/** Who decides, removes and pins on a roster: team admins (team), site admins (site). */
export function rosterAdmin(actor: RosterActor, target: RosterTarget): boolean {
  return target === "team" ? teamRoleAllows(actor.role, "team.agents.manage") : actor.siteAdmin;
}

/**
 * Whether `POST /v1/agents/:id/assignments` lands directly or as a proposal, or why it is refused
 * (AR6, AR8). The owner assigns their own personal agent; a builder may also put someone else's
 * site-assigned agent on the team roster (§5 "builder (reference, any team)").
 */
export function assignDecision(
  actor: RosterActor,
  s: RosterSubject,
  target: RosterTarget,
): AssignDecision {
  if (s.kind !== "personal") return { ok: false, error: "forbidden" };
  const builder = teamRoleAllows(actor.role, "team.agents.build");
  const own = isOwn(actor, s);
  const byReference = !own && target === "team" && builder && s.siteEntry === "active";
  if (!own && !byReference) return { ok: false, error: "forbidden" };
  if (s.archived) return { ok: false, error: "agent_archived" };
  if (s.boundTeamId !== null && (target === "site" || s.boundTeamId !== actor.teamId)) {
    return { ok: false, error: "agent_bound_to_team" };
  }
  if (liveEntry(target === "team" ? s.teamEntry : s.siteEntry)) {
    return { ok: false, error: "already_on_roster" };
  }
  if (target === "team") return { ok: true, mode: builder ? "direct" : "propose" };
  if (actor.siteAdmin) return { ok: true, mode: "direct" };
  // Only published agents can be proposed to the site (AR6).
  return s.published ? { ok: true, mode: "propose" } : { ok: false, error: "agent_not_published" };
}

/** Reading the definition from a roster row (§5 "View definition"). */
function rosterReadsDefinition(actor: RosterActor, s: RosterSubject, tab: RosterTab): boolean {
  if (isOwn(actor, s)) return true;
  if (tab === "team") return teamRoleAllows(actor.role, "team.agents.build");
  if (tab === "site") return teamRoleAllows(actor.role, "team.agents.use");
  return false;
}

function rosterEdits(actor: RosterActor, s: RosterSubject): boolean {
  if (s.kind === "personal") return isOwn(actor, s) && agentAccess(actor, toRef(s)).edit;
  if (s.kind === "team_owned") return agentAccess(actor, toRef(s)).edit;
  return actor.siteAdmin; // gallery agents: the Site Console editor (KOBE-494)
}

const toRef = (s: RosterSubject): AgentRef => ({
  scope: s.kind === "team_owned" ? "team" : s.kind,
  ownerUserId: s.ownerUserId,
});

/** "Suspended here" (team admins): which way the toggle goes on this row, if offered. */
function hereToggle(actor: RosterActor, s: RosterSubject, tab: RosterTab) {
  const none = { suspendHere: false, resumeHere: false };
  if (!teamRoleAllows(actor.role, "team.agents.suspend")) return none;
  let suspended: boolean;
  if (tab === "team" && s.kind === "team_owned") suspended = s.suspended;
  else if (tab === "team" && s.kind === "personal" && assignedEntry(s.teamEntry))
    suspended = s.suspendedHere;
  else if (tab === "site" && (s.kind === "gallery" || assignedEntry(s.siteEntry)))
    suspended = s.suspendedHere;
  else return none;
  return { suspendHere: !suspended, resumeHere: suspended };
}

/**
 * The actions a roster row offers the caller (§5). The server enforces the same rules on every
 * write; this is what lets the web render a row's buttons without its own rulebook.
 */
export function rosterActions(actor: RosterActor, s: RosterSubject, tab: RosterTab): RosterActions {
  const own = isOwn(actor, s);
  const use = teamRoleAllows(actor.role, "team.agents.use");
  const view = tab === "personal" ? own : use || own;
  const readDefinition = view && rosterReadsDefinition(actor, s, tab);
  const assign = (target: RosterTarget) => {
    const d = assignDecision(actor, s, target);
    return d.ok ? d.mode : null;
  };
  const rosterTarget: RosterTarget | null = tab === "personal" ? null : tab;
  const entry =
    rosterTarget === "team" ? s.teamEntry : rosterTarget === "site" ? s.siteEntry : null;
  const admin = rosterTarget !== null && s.kind === "personal" && rosterAdmin(actor, rosterTarget);
  const siteWide = tab === "site" && actor.siteAdmin && s.kind === "personal";
  return {
    view,
    viewDefinition: readDefinition,
    edit: view && rosterEdits(actor, s),
    fork: readDefinition,
    assignTeam: assign("team"),
    assignSite: assign("site"),
    withdrawTeam: own && liveEntry(s.teamEntry),
    withdrawSite: own && liveEntry(s.siteEntry),
    decide: admin && entry === "proposed",
    remove: admin && assignedEntry(entry),
    pin: admin && assignedEntry(entry),
    ...hereToggle(actor, s, tab),
    suspendSiteWide: siteWide && s.siteEntry === "active",
    resumeSiteWide: siteWide && s.siteEntry === "suspended",
    // Adopt (KOBE-568 routes): an assigned entry into the roster's ownership; a bound agent only
    // into its own team (AR8, AR10).
    adopt:
      admin &&
      assignedEntry(entry) &&
      (s.boundTeamId === null || (rosterTarget === "team" && s.boundTeamId === actor.teamId)),
  };
}

/**
 * The team a fork from this row would be bound to (AR8, KOBE-571: the fork dialog's notice), as
 * the fork route decides it (`findForkSource` + {@link forkBinding}): the team's own agent and a
 * team entry bind to the active team, a site entry wins over a team entry (unbound), a bound
 * agent keeps its team, gallery agents are unbound.
 */
export function rowForkBinding(actor: RosterActor, s: RosterSubject): string | null {
  const via: ForkVia =
    s.kind === "team_owned"
      ? "team_owned"
      : s.kind === "gallery"
        ? "gallery"
        : isOwn(actor, s)
          ? "own"
          : assignedEntry(s.siteEntry)
            ? "site_entry"
            : "team_entry";
  return forkBinding(via, s.kind === "personal" ? s.boundTeamId : null, actor.teamId);
}
