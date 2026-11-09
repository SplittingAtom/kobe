import { isDangerousMode, type AgentFrontmatter } from "@kobe/agent-file";
import {
  and,
  eq,
  inArray,
  or,
  siteAgentRoster,
  siteAgents,
  siteAgentVersions,
  teamAgents,
  teamAgentSuspensions,
  users,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type {
  AgentLineage,
  AgentReach,
  AgentRosterKind,
  AgentRosterPage,
  AgentRosterRow,
  AgentRosterStatus,
  AgentRosterTab,
} from "@kobe/protocol";
import { AGENT_ROSTER_PAGE_MAX } from "@kobe/protocol";
import {
  agentAccess,
  rosterActions,
  rosterAdmin,
  rowForkBinding,
  type RosterActor,
  type RosterEntryState,
  type RosterSubject,
} from "./access.js";
import {
  entryView,
  reachOf,
  resolvedVersion,
  siteEntries,
  teamEntries,
  updateAvailable,
  type RosterEntryRecord,
} from "./roster.js";
import { entryUnavailable, ownerStates, type UnavailableReason } from "./roster-resolution.js";
import { SITE, siteWhere, TEAM, type Row } from "./store.js";
import { teamRoleAllows } from "../authz/permissions.js";
import { usageOf, type UsageSubject } from "./inventory.js";
import { lineageOf } from "./lineage.js";

const GONE = { member: false, deactivated: true } as const;

/**
 * `GET /v1/agents/roster?tab=` (KOBE-566, spec agents-roster AR1, AR2, §6.8): one tab's rows with
 * the caller's actions. Personal: the caller's own agents with their Reach. Team: the team's own
 * agents plus assigned personal agents. Site: gallery agents plus site-assigned personal agents.
 * Proposals show to their proposer, the owner and the roster's admins; removed entries to nobody;
 * archived agents to the owner and the roster's admins. Lists are bounded by the agent and roster
 * caps, so rows are built in memory and paged by (name, id). Team reads run in `withTeam()` with
 * `team_id` explicit.
 */

export const ROSTER_PAGE_DEFAULT = AGENT_ROSTER_PAGE_MAX;

/** One agent as the tab knows it, before the caller's actions are applied. */
interface Candidate {
  readonly row: Row & { readonly boundTeamId: string | null };
  readonly kind: AgentRosterKind;
  /** What the row shows (draft, or the version in effect for someone else's agent). */
  readonly display: AgentFrontmatter | null;
  readonly entry: RosterEntryRecord | null;
  readonly subject: RosterSubject;
  readonly reach?: readonly AgentReach[];
  /** Personal tab: where the agent was forked from (KOBE-571). */
  readonly forkedFrom?: AgentLineage;
  /** An entry whose owner left the team or was deactivated (AR10, KOBE-567). */
  readonly unavailable?: UnavailableReason | null;
}

const SITE_ROW = { ...SITE, boundTeamId: siteAgents.boundTeamId };

/** Cursor = base64url JSON of the last row's (name, id). */
export function encodeCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify([name, id])).toString("base64url");
}

export function decodeCursor(cursor: string): readonly [string, string] | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "string")) {
      return [value[0] as string, value[1] as string];
    }
  } catch {
    // fall through
  }
  return null;
}

const compare = (a: readonly [string, string], b: readonly [string, string]) =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;

function statusOf(c: Candidate, tab: AgentRosterTab): AgentRosterStatus {
  const { row, entry, subject } = c;
  if (row.archivedAt !== null) return "archived";
  if (entry?.state === "proposed") return "proposed";
  if (c.unavailable) return "unavailable";
  if (
    tab === "site" &&
    (entry?.state === "suspended" || (c.kind === "gallery" && row.status === "suspended"))
  )
    return "suspended_site";
  if (
    tab !== "personal" &&
    (subject.suspended || subject.suspendedHere || entry?.state === "suspended")
  )
    return "suspended_here";
  if (row.currentVersion === null) return "not_published";
  return "active";
}

function toRow(
  actor: RosterActor,
  tab: AgentRosterTab,
  c: Candidate,
  names: ReadonlyMap<string, string>,
): AgentRosterRow {
  const { row, display, entry } = c;
  const fm = display;
  const current = row.currentVersion;
  const actions = rosterActions(actor, c.subject, tab);
  return {
    agentId: row.id,
    kind: c.kind,
    slug: row.slug,
    name: fm?.name ?? row.slug,
    ...(fm?.description !== undefined ? { description: fm.description } : {}),
    ...(fm?.icon !== undefined ? { icon: fm.icon } : {}),
    dangerous: fm ? isDangerousMode(fm) : false,
    ownerUserId: row.ownerUserId,
    ownerName: row.ownerUserId ? (names.get(row.ownerUserId) ?? null) : null,
    boundTeamId: row.boundTeamId,
    status: statusOf(c, tab),
    ...(c.unavailable && statusOf(c, tab) === "unavailable"
      ? { unavailableReason: c.unavailable }
      : {}),
    currentVersion: current,
    versionInEffect: entry ? resolvedVersion(entry, current) : current,
    updateAvailable: entry ? updateAvailable(entry, current) : false,
    entry: entry ? entryView(entry) : null,
    ...(c.reach ? { reach: [...c.reach] } : {}),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    actions,
    ...(actions.fork ? { forkBoundTeamId: rowForkBinding(actor, c.subject) } : {}),
    ...(c.forkedFrom ? { forkedFrom: c.forkedFrom } : {}),
  };
}

/** Whether the caller sees this candidate on the tab at all (beyond the matrix's `view`). */
function visible(actor: RosterActor, tab: AgentRosterTab, c: Candidate): boolean {
  if (tab === "personal") return true;
  const own = c.row.ownerUserId === actor.userId;
  const admin =
    c.kind === "team_owned"
      ? rosterAdmin(actor, "team")
      : c.kind === "gallery"
        ? actor.siteAdmin
        : rosterAdmin(actor, tab);
  if (c.entry?.state === "removed") return false;
  // Unavailable entries are for the roster's admins to resolve (AR10): Adopt, remove.
  if (c.unavailable && c.entry?.state !== "proposed" && !admin) return false;
  if (c.entry?.state === "proposed" && !(own || admin || c.entry.assignedBy === actor.userId))
    return false;
  return c.row.archivedAt === null || own || admin;
}

const subjectOf = (
  kind: AgentRosterKind,
  row: Candidate["row"],
  states: { team: RosterEntryState | null; site: RosterEntryState | null; here: boolean },
): RosterSubject => ({
  kind,
  ownerUserId: row.ownerUserId,
  boundTeamId: row.boundTeamId,
  published: row.currentVersion !== null,
  archived: row.archivedAt !== null,
  suspended: kind === "team_owned" && row.status === "suspended",
  teamEntry: states.team,
  siteEntry: states.site,
  suspendedHere: states.here,
});

/** Names of the given users (owners on the rows). */
async function namesOf(
  db: KobeDb | KobeTx,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** The frontmatter of the given published versions of site agents, by agent id. */
async function versionFrontmatter(
  tx: KobeTx | KobeDb,
  pairs: readonly (readonly [string, number])[],
): Promise<ReadonlyMap<string, AgentFrontmatter>> {
  if (pairs.length === 0) return new Map();
  const rows = await tx
    .select({ agentId: siteAgentVersions.agentId, frontmatter: siteAgentVersions.frontmatter })
    .from(siteAgentVersions)
    .where(
      or(
        ...pairs.map(([id, v]) =>
          and(eq(siteAgentVersions.agentId, id), eq(siteAgentVersions.version, v)),
        ),
      ),
    );
  return new Map(rows.map((r) => [r.agentId, r.frontmatter as AgentFrontmatter]));
}

/** Someone else's personal agent shows the version its entry runs, never the owner's draft. */
async function entryCandidates(
  tx: KobeTx,
  actor: RosterActor,
  entries: readonly RosterEntryRecord[],
  states: (agentId: string) => {
    team: RosterEntryState | null;
    site: RosterEntryState | null;
    here: boolean;
  },
): Promise<Candidate[]> {
  const ids = entries.map((e) => e.agentId);
  if (ids.length === 0) return [];
  const agents = await tx
    .select(SITE_ROW)
    .from(siteAgents)
    .where(and(inArray(siteAgents.id, ids), eq(siteAgents.scope, "personal")));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const pairs = entries.flatMap((e) => {
    const a = byId.get(e.agentId);
    const v = a ? resolvedVersion(e, a.currentVersion) : null;
    return a && a.ownerUserId !== actor.userId && v !== null ? [[e.agentId, v] as const] : [];
  });
  const published = await versionFrontmatter(tx, pairs);
  const owners = await ownerStates(
    tx,
    actor.teamId,
    agents.flatMap((a) => (a.ownerUserId ? [a.ownerUserId] : [])),
  );
  return entries.flatMap((entry) => {
    const row = byId.get(entry.agentId);
    if (!row) return []; // an entry of a deleted agent is inert (KOBE-565)
    const own = row.ownerUserId === actor.userId;
    const display = own
      ? (row.frontmatter as AgentFrontmatter)
      : (published.get(entry.agentId) ?? null);
    return [
      {
        row,
        kind: "personal" as const,
        display,
        entry,
        subject: subjectOf("personal", row, states(entry.agentId)),
        unavailable: row.ownerUserId
          ? entryUnavailable(entry, owners.get(row.ownerUserId) ?? GONE)
          : null,
      },
    ];
  });
}

async function suspendedIn(tx: KobeTx, teamId: string): Promise<ReadonlySet<string>> {
  const rows = await tx
    .select({ id: teamAgentSuspensions.agentId })
    .from(teamAgentSuspensions)
    .where(eq(teamAgentSuspensions.teamId, teamId));
  return new Set(rows.map((r) => r.id));
}

async function personalCandidates(db: KobeDb, actor: RosterActor): Promise<Candidate[]> {
  const own = await db
    .select(SITE_ROW)
    .from(siteAgents)
    .where(siteWhere({ scope: "personal", ownerUserId: actor.userId }));
  const reach = await reachOf(
    db,
    own.map((a) => a.id),
  );
  const lineage = await lineageOf(db, actor, own);
  return own.map((row): Candidate => {
    const forkedFrom = lineage.get(row.id);
    const items = reach.get(row.id) ?? [];
    const team = items.find((r) => r.target === "team" && r.teamId === actor.teamId)?.state ?? null;
    const site = items.find((r) => r.target === "site")?.state ?? null;
    return {
      row,
      kind: "personal" as const,
      display: row.frontmatter as AgentFrontmatter,
      entry: null,
      subject: subjectOf("personal", row, { team, site, here: false }),
      reach: items,
      ...(forkedFrom ? { forkedFrom } : {}),
    };
  });
}

/** Inside the read's `withTeam(actor.teamId)`; every team query states `team_id`. */
async function teamCandidates(tx: KobeTx, actor: RosterActor): Promise<Candidate[]> {
  const teamId = actor.teamId;
  const owned = await tx.select(TEAM).from(teamAgents).where(eq(teamAgents.teamId, teamId));
  const entries = await teamEntries(tx, teamId);
  const here = await suspendedIn(tx, teamId);
  const ids = entries.map((e) => e.agentId);
  const site =
    ids.length === 0
      ? []
      : await tx
          .select({ id: siteAgentRoster.siteAgentId, state: siteAgentRoster.state })
          .from(siteAgentRoster)
          .where(inArray(siteAgentRoster.siteAgentId, ids));
  const siteState = new Map(site.map((s) => [s.id, s.state]));
  const teamState = new Map(entries.map((e) => [e.agentId, e.state]));
  const assigned = await entryCandidates(tx, actor, entries, (id) => ({
    team: teamState.get(id) ?? null,
    site: siteState.get(id) ?? null,
    here: here.has(id),
  }));
  const ownedCandidates = owned.map((r) => {
    const row = { ...r, boundTeamId: null };
    return {
      row,
      kind: "team_owned" as const,
      display: r.frontmatter as AgentFrontmatter,
      entry: null,
      subject: subjectOf("team_owned", row, { team: null, site: null, here: false }),
    };
  });
  return [...ownedCandidates, ...assigned];
}

/** Inside the read's `withTeam(actor.teamId)` (this team's suspensions and entries). */
async function siteCandidates(tx: KobeTx, actor: RosterActor): Promise<Candidate[]> {
  const gallery = await tx.select(SITE_ROW).from(siteAgents).where(eq(siteAgents.scope, "gallery"));
  const entries = await siteEntries(tx);
  const here = await suspendedIn(tx, actor.teamId);
  const siteState = new Map(entries.map((e) => [e.agentId, e.state]));
  const teamState = new Map((await teamEntries(tx, actor.teamId)).map((e) => [e.agentId, e.state]));
  const assigned = await entryCandidates(tx, actor, entries, (id) => ({
    team: teamState.get(id) ?? null,
    site: siteState.get(id) ?? null,
    here: here.has(id),
  }));
  const galleryCandidates = gallery.map((row) => ({
    row,
    kind: "gallery" as const,
    display: row.frontmatter as AgentFrontmatter,
    entry: null,
    subject: subjectOf("gallery", row, { team: null, site: null, here: here.has(row.id) }),
  }));
  return [...galleryCandidates, ...assigned];
}

const INVENTORY_SCOPE: Readonly<Record<AgentRosterKind, UsageSubject["scope"]>> = {
  personal: "personal",
  team_owned: "team",
  gallery: "gallery",
};

/**
 * Team admins see the inventory's columns on the Team and Site tabs (KOBE-570, AR12): runs, last
 * run, tokens, schedules and Orbit score of each row's agent in the active team, with the same
 * right the inventory route asks (`team.agents.suspend`). Read in the tab's own transaction (same
 * snapshot as the rows), team explicit.
 */
async function withUsage(
  tx: KobeTx,
  actor: RosterActor,
  rows: AgentRosterRow[],
): Promise<AgentRosterRow[]> {
  if (rows.length === 0 || !teamRoleAllows(actor.role, "team.agents.suspend")) return rows;
  const usage = await usageOf(
    tx,
    actor.teamId,
    rows.map((r) => ({
      id: r.agentId,
      scope: INVENTORY_SCOPE[r.kind],
      currentVersion: r.currentVersion,
    })),
  );
  return rows.map((r) => {
    const u = usage.get(r.agentId);
    if (!u) return r;
    const scope = INVENTORY_SCOPE[r.kind];
    const canExport = agentAccess(actor, { scope, ownerUserId: r.ownerUserId }).readDefinition;
    return { ...r, usage: { ...u, schedules: [...u.schedules], canExport } };
  });
}

type RosterQuery = {
  tab: AgentRosterTab;
  cursor?: readonly [string, string] | null;
  limit?: number;
};

/**
 * The caller's rows of the tab, one page, with the count of proposals waiting for the caller's
 * decision across the whole roster (§6.4) for the tab's admins.
 */
async function pageOf(
  conn: KobeDb | KobeTx,
  actor: RosterActor,
  query: RosterQuery,
  candidates: readonly Candidate[],
): Promise<{ page: AgentRosterRow[]; rest: number; proposedCount?: number }> {
  const { tab } = query;
  const names = await namesOf(
    conn,
    candidates.flatMap((c) => (c.row.ownerUserId ? [c.row.ownerUserId] : [])),
  );
  const rows = candidates
    .filter((c) => visible(actor, tab, c))
    .map((c) => toRow(actor, tab, c, names))
    .filter((r) => r.actions.view)
    .sort((a, b) => compare([a.name, a.agentId], [b.name, b.agentId]));
  const after = query.cursor;
  const rest = after ? rows.filter((r) => compare([r.name, r.agentId], after) > 0) : rows;
  const limit = query.limit ?? ROSTER_PAGE_DEFAULT;
  const decides = tab !== "personal" && rosterAdmin(actor, tab);
  return {
    page: rest.slice(0, limit),
    rest: rest.length,
    ...(decides
      ? { proposedCount: rows.filter((r) => r.status === "proposed" && r.actions.decide).length }
      : {}),
  };
}

export async function listRoster(
  db: KobeDb,
  actor: RosterActor,
  query: RosterQuery,
): Promise<AgentRosterPage> {
  const { tab } = query;
  const limit = query.limit ?? ROSTER_PAGE_DEFAULT;
  const result =
    tab === "personal"
      ? await pageOf(db, actor, query, await personalCandidates(db, actor))
      : await withTeam(db, actor.teamId, async (tx) => {
          const candidates =
            tab === "team" ? await teamCandidates(tx, actor) : await siteCandidates(tx, actor);
          const read = await pageOf(tx, actor, query, candidates);
          return { ...read, page: await withUsage(tx, actor, read.page) };
        });
  const last = result.page.at(-1);
  return {
    tab,
    rows: result.page,
    nextCursor: result.rest > limit && last ? encodeCursor(last.name, last.agentId) : null,
    ...(result.proposedCount === undefined ? {} : { proposedCount: result.proposedCount }),
  };
}
