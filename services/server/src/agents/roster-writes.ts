import {
  and,
  eq,
  inArray,
  siteAgentRoster,
  siteAgents,
  sql,
  teamAgentRoster,
  teamAgentSuspensions,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import {
  AGENT_ROSTER_CAP,
  AGENT_ROSTER_PROPOSALS_CAP,
  type AgentRosterErrorCode,
  type AgentVersionRuleInput,
} from "@kobe/protocol";
import type { ServerAuditEvent } from "../audit/record.js";
import { recordAudit } from "../audit/record.js";
import {
  assignDecision,
  rosterAdmin,
  type RosterActor,
  type SiteRosterActor,
  type RosterEntryState,
  type RosterTarget,
} from "./access.js";
import { siteEntry, teamEntry, type RosterEntryRecord } from "./roster.js";

/**
 * Roster writes (KOBE-566, spec agents-roster AR5-AR7, §6.4, §6.5): assign or propose, withdraw,
 * and the roster admins' approve, decline, pin, update, remove, suspend and resume. Each runs in
 * one transaction that locks the agent's row (so a delete can't race it, §6.3), serializes writes
 * per roster (caps), and audits. Team entries are written inside `withTeam()` with `team_id`
 * explicit; the team roster's suspension of an agent is also this team's `team_agent_suspensions`
 * row, the one fact run start and pinning already check (AR9).
 */

export type RosterError = Extract<
  AgentRosterErrorCode,
  | "forbidden"
  | "agent_not_found"
  | "roster_entry_not_found"
  | "version_not_found"
  | "agent_archived"
  | "already_on_roster"
  | "invalid_transition"
  | "roster_limit"
  | "agent_bound_to_team"
  | "agent_not_published"
  | "version_rule_not_allowed"
>;
export type RosterResult<T> = { ok: true; value: T } | { ok: false; error: RosterError };

const fail = (error: RosterError): { ok: false; error: RosterError } => ({ ok: false, error });

/** The personal agent behind an entry: what the rules and the audit need, never a definition. */
interface PersonalAgent {
  readonly id: string;
  readonly slug: string;
  readonly ownerUserId: string;
  readonly boundTeamId: string | null;
  readonly currentVersion: number | null;
  readonly archivedAt: Date | null;
}

/** Locks the personal agent against deletion for this transaction (`FOR SHARE`). */
async function lockPersonalAgent(tx: KobeTx, id: string): Promise<PersonalAgent | null> {
  const [row] = await tx
    .select({
      id: siteAgents.id,
      slug: siteAgents.slug,
      ownerUserId: siteAgents.ownerUserId,
      boundTeamId: siteAgents.boundTeamId,
      currentVersion: siteAgents.currentVersion,
      archivedAt: siteAgents.archivedAt,
    })
    .from(siteAgents)
    .where(and(eq(siteAgents.id, id), eq(siteAgents.scope, "personal")))
    .for("share");
  return row?.ownerUserId ? { ...row, ownerUserId: row.ownerUserId } : null;
}

/** Serializes writes to one roster, so caps and re-assignments can't race. */
async function lockRoster(tx: KobeTx, target: RosterTarget, teamId: string | null): Promise<void> {
  const key = target === "team" ? `agent-roster:team:${teamOf(teamId)}` : "agent-roster:site";
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** Runs `fn` in the target roster's transaction: team-scoped (RLS) or plain for the site. */
function inRoster<T>(
  db: KobeDb,
  target: RosterTarget,
  teamId: string | null,
  fn: (tx: KobeTx) => Promise<T>,
) {
  return target === "team" ? withTeam(db, teamOf(teamId), fn) : db.transaction(fn);
}

/** The team of a team-roster write; a site-only actor never reaches a team branch. */
function teamOf(teamId: string | null): string {
  if (teamId === null) throw new Error("roster: a team roster write needs a team");
  return teamId;
}

const entryOf = (tx: KobeTx, target: RosterTarget, teamId: string | null, agentId: string) =>
  target === "team" ? teamEntry(tx, teamOf(teamId), agentId, true) : siteEntry(tx, agentId, true);

/** Entries holding `states` on the roster (the caps count assigned entries and proposals apart). */
async function countEntries(
  tx: KobeTx,
  target: RosterTarget,
  teamId: string | null,
  states: readonly RosterEntryState[],
): Promise<number> {
  const [row] =
    target === "team"
      ? await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(teamAgentRoster)
          .where(
            and(
              eq(teamAgentRoster.teamId, teamOf(teamId)),
              inArray(teamAgentRoster.state, [...states]),
            ),
          )
      : await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(siteAgentRoster)
          .where(inArray(siteAgentRoster.state, [...states]));
  return row?.n ?? 0;
}

async function hasRoom(tx: KobeTx, target: RosterTarget, teamId: string | null, proposal: boolean) {
  return proposal
    ? (await countEntries(tx, target, teamId, ["proposed"])) < AGENT_ROSTER_PROPOSALS_CAP
    : (await countEntries(tx, target, teamId, ["active", "suspended"])) < AGENT_ROSTER_CAP;
}

type Rule = { versionRule: "latest" | "pinned"; pinnedVersion: number | null };

/** A version rule from a request, checked against the agent's published versions (1..current). */
function ruleOf(input: AgentVersionRuleInput | undefined, agent: PersonalAgent): Rule | null {
  if (input === undefined || input === "latest")
    return { versionRule: "latest", pinnedVersion: null };
  if (agent.currentVersion === null || input > agent.currentVersion) return null;
  return { versionRule: "pinned", pinnedVersion: input };
}

type EntryChange = Partial<{
  state: RosterEntryState;
  versionRule: "latest" | "pinned";
  pinnedVersion: number | null;
  assignedBy: string;
  assignedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  note: string | null;
  removedAt: Date | null;
}>;

async function writeEntry(
  tx: KobeTx,
  target: RosterTarget,
  rosterTeam: string | null,
  agentId: string,
  change: EntryChange,
  insert: boolean,
): Promise<RosterEntryRecord> {
  if (target === "team") {
    const teamId = teamOf(rosterTeam);
    if (insert) {
      await tx.insert(teamAgentRoster).values({
        teamId,
        siteAgentId: agentId,
        assignedBy: change.assignedBy ?? "",
        ...change,
      });
    } else {
      await tx
        .update(teamAgentRoster)
        .set(change)
        .where(and(eq(teamAgentRoster.teamId, teamId), eq(teamAgentRoster.siteAgentId, agentId)));
    }
    const entry = await teamEntry(tx, teamId, agentId);
    if (!entry) throw new Error("roster: team entry vanished after write");
    return entry;
  }
  if (insert) {
    await tx
      .insert(siteAgentRoster)
      .values({ siteAgentId: agentId, assignedBy: change.assignedBy ?? "", ...change });
  } else {
    await tx.update(siteAgentRoster).set(change).where(eq(siteAgentRoster.siteAgentId, agentId));
  }
  const entry = await siteEntry(tx, agentId);
  if (!entry) throw new Error("roster: site entry vanished after write");
  return entry;
}

type RosterAction =
  | "assigned"
  | "proposed"
  | "approved"
  | "declined"
  | "pinned"
  | "updated"
  | "removed"
  | "withdrawn"
  | "suspended"
  | "resumed";

function audit(
  tx: KobeTx,
  action: RosterAction,
  target: RosterTarget,
  teamId: string | null,
  agent: { id: string; slug: string; scope?: "personal" | "gallery" },
  rule?: Rule,
) {
  const ref = {
    agentId: agent.id,
    scope: agent.scope ?? "personal",
    slug: agent.slug,
    roster: target,
  };
  return recordAudit(tx, {
    action: `agent.roster.${action}`,
    teamId: target === "team" ? teamOf(teamId) : null,
    target: rule ? { ...ref, ...rule } : ref,
  } as ServerAuditEvent);
}

export interface AssignInput {
  readonly agentId: string;
  readonly target: RosterTarget;
  readonly versionRule?: AgentVersionRuleInput | undefined;
}

/** `POST /v1/agents/:id/assignments`: an active entry (direct) or a proposal (AR6). */
export async function assignAgent(
  db: KobeDb,
  actor: RosterActor,
  input: AssignInput,
): Promise<RosterResult<{ entry: RosterEntryRecord; mode: "direct" | "propose" }>> {
  const { target, agentId } = input;
  return inRoster(db, target, actor.teamId, async (tx) => {
    await lockRoster(tx, target, actor.teamId);
    const agent = await lockPersonalAgent(tx, agentId);
    if (!agent) return fail("agent_not_found");
    const team = target === "team" ? await teamEntry(tx, actor.teamId, agentId, true) : null;
    const site = await siteEntry(tx, agentId, target === "site");
    // Someone else's agent exists for the caller only while it is on the site roster (no oracle).
    if (agent.ownerUserId !== actor.userId && site?.state !== "active") {
      return fail("agent_not_found");
    }
    const decision = assignDecision(
      actor,
      {
        kind: "personal",
        ownerUserId: agent.ownerUserId,
        boundTeamId: agent.boundTeamId,
        published: agent.currentVersion !== null,
        archived: agent.archivedAt !== null,
        suspended: false,
        teamEntry: team?.state ?? null,
        siteEntry: site?.state ?? null,
        suspendedHere: false,
      },
      target,
    );
    if (!decision.ok) return fail(decision.error);
    // Only the roster's admins pin (AR5): everyone else assigns or proposes following latest.
    const pins = input.versionRule !== undefined && input.versionRule !== "latest";
    if (pins && !rosterAdmin(actor, target)) return fail("version_rule_not_allowed");
    const rule = ruleOf(input.versionRule, agent);
    if (!rule) return fail("version_not_found");
    const proposal = decision.mode === "propose";
    if (!(await hasRoom(tx, target, actor.teamId, proposal))) return fail("roster_limit");
    const existing = target === "team" ? team : site;
    // A removed entry is re-assigned in place (AR7); `removedAt` stays as history.
    const entry = await writeEntry(
      tx,
      target,
      actor.teamId,
      agentId,
      {
        state: proposal ? "proposed" : "active",
        ...rule,
        assignedBy: actor.userId,
        assignedAt: new Date(),
        decidedBy: null,
        decidedAt: null,
        note: null,
      },
      existing === null,
    );
    await audit(
      tx,
      proposal ? "proposed" : "assigned",
      target,
      actor.teamId,
      agent,
      proposal ? undefined : rule,
    );
    return { ok: true, value: { entry, mode: decision.mode } };
  });
}

/**
 * `DELETE /v1/agents/:id/assignments/:target`: the owner withdraws an entry or proposal (AR7).
 * `teamId` names a team roster other than the active team: the owner may withdraw their own agent
 * from a team they have left (its Reach lists it), or it could never be deleted (§6.3).
 */
export async function withdrawAgent(
  db: KobeDb,
  actor: RosterActor,
  agentId: string,
  target: RosterTarget,
  teamId: string = actor.teamId,
): Promise<RosterResult<RosterEntryRecord>> {
  return inRoster(db, target, teamId, async (tx) => {
    await lockRoster(tx, target, teamId);
    const agent = await lockPersonalAgent(tx, agentId);
    if (!agent || agent.ownerUserId !== actor.userId) return fail("agent_not_found");
    const entry = await entryOf(tx, target, teamId, agentId);
    if (!entry || entry.state === "removed") return fail("roster_entry_not_found");
    const updated = await writeEntry(
      tx,
      target,
      teamId,
      agentId,
      { state: "removed", removedAt: new Date() },
      false,
    );
    await audit(tx, "withdrawn", target, teamId, agent);
    return { ok: true, value: updated };
  });
}

export interface AdminUpdate {
  readonly agentId: string;
  readonly target: RosterTarget;
  readonly state: "active" | "removed" | "suspended";
  readonly versionRule?: AgentVersionRuleInput | undefined;
  readonly note?: string | undefined;
}

/** What an admin's PUT does to an entry in `from` (null: refused as an invalid transition). */
function transition(from: RosterEntryState, to: AdminUpdate["state"], hasRule: boolean) {
  if (from === "proposed")
    return to === "active" ? "approved" : to === "removed" ? "declined" : null;
  if (from === "active") {
    if (to === "removed") return "removed";
    if (to === "suspended") return "suspended";
    return hasRule ? "rule" : "unchanged";
  }
  if (from === "suspended") {
    if (to === "removed") return "removed";
    if (to === "active") return "resumed";
    return "unchanged";
  }
  return null; // removed: only the owner re-assigns (AR7)
}

/**
 * This team's suspension of a site-wide agent (`team_agent_suspensions`), set or lifted: the only
 * record of "suspended here", also for team roster entries (whose state stays `active`).
 */
async function setSuspendedHere(
  tx: KobeTx,
  actor: RosterActor,
  agentId: string,
  scope: "personal" | "gallery",
  suspended: boolean,
): Promise<void> {
  if (suspended) {
    await tx
      .insert(teamAgentSuspensions)
      .values({ teamId: actor.teamId, agentId, agentScope: scope, suspendedBy: actor.userId })
      .onConflictDoNothing();
  } else {
    await tx
      .delete(teamAgentSuspensions)
      .where(
        and(
          eq(teamAgentSuspensions.teamId, actor.teamId),
          eq(teamAgentSuspensions.agentId, agentId),
        ),
      );
  }
}

/**
 * `PUT /v1/team|site/agent-roster/:agentId` on an entry (roster admins, §6.4, §6.5). Null when the
 * team route should act on this team's suspension instead: no team entry, or `suspended` /
 * `active` (resume) without a version rule on a team entry, since a team's suspension lives only in
 * `team_agent_suspensions`. `state = suspended` is a site roster state (site-wide).
 */
export async function updateEntry(
  db: KobeDb,
  actor: RosterActor | SiteRosterActor,
  input: AdminUpdate,
): Promise<RosterResult<RosterEntryRecord> | null> {
  const { target, agentId } = input;
  const teamId = "teamId" in actor ? actor.teamId : null;
  const admin =
    target === "team" ? "teamId" in actor && rosterAdmin(actor, "team") : actor.siteAdmin;
  if (!admin) return fail("forbidden");
  return inRoster(db, target, teamId, async (tx) => {
    await lockRoster(tx, target, teamId);
    const agent = await lockPersonalAgent(tx, agentId);
    const entry = agent ? await entryOf(tx, target, teamId, agentId) : null;
    if (!agent || !entry) return null;
    const noRule = input.versionRule === undefined;
    const suspension =
      input.state === "suspended" || (input.state === "active" && entry.state !== "proposed");
    if (target === "team" && noRule && suspension) return null;
    const step = transition(entry.state, input.state, !noRule);
    if (step === null) return fail("invalid_transition");
    const rule = noRule ? null : ruleOf(input.versionRule, agent);
    if (!noRule && !rule) return fail("version_not_found");
    const now = new Date();
    const decided = { decidedBy: actor.userId, decidedAt: now };
    const note = input.note === undefined ? {} : { note: input.note === "" ? null : input.note };
    const write = (change: EntryChange) => writeEntry(tx, target, teamId, agentId, change, false);
    switch (step) {
      case "approved": {
        if (agent.archivedAt !== null) return fail("agent_archived");
        if (!(await hasRoom(tx, target, teamId, false))) return fail("roster_limit");
        // Approve follows latest unless the admin chose a version (§6.4).
        const approved = rule ?? { versionRule: "latest" as const, pinnedVersion: null };
        const updated = await write({ state: "active", ...approved, ...decided, ...note });
        await audit(tx, "approved", target, teamId, agent, approved);
        return { ok: true, value: updated };
      }
      case "declined":
      case "removed": {
        const updated = await write({ state: "removed", removedAt: now, ...decided, ...note });
        await audit(tx, step, target, teamId, agent);
        return { ok: true, value: updated };
      }
      case "suspended": {
        // Site roster only: a team's suspension returned null above.
        const updated = await write({ state: "suspended", ...decided, ...note });
        await audit(tx, "suspended", target, teamId, agent);
        return { ok: true, value: updated };
      }
      case "resumed": {
        const updated = await write({ state: "active", ...(rule ?? {}), ...decided, ...note });
        await audit(tx, "resumed", target, teamId, agent);
        if (rule) await auditRule(tx, entry, rule, target, teamId, agent);
        return { ok: true, value: updated };
      }
      case "rule": {
        if (!rule || sameRule(entry, rule)) return { ok: true, value: entry };
        const updated = await write({ ...rule, ...decided, ...note });
        await auditRule(tx, entry, rule, target, teamId, agent);
        return { ok: true, value: updated };
      }
      case "unchanged":
        return { ok: true, value: entry };
    }
  });
}

const sameRule = (entry: RosterEntryRecord, rule: Rule) =>
  entry.versionRule === rule.versionRule && entry.pinnedVersion === rule.pinnedVersion;

/** Pinning a following entry is `pinned`; moving a pin (or back to latest) is `updated` (AR5). */
async function auditRule(
  tx: KobeTx,
  before: RosterEntryRecord,
  rule: Rule,
  target: RosterTarget,
  teamId: string | null,
  agent: PersonalAgent,
) {
  if (sameRule(before, rule)) return;
  const action =
    before.versionRule === "latest" && rule.versionRule === "pinned" ? "pinned" : "updated";
  await audit(tx, action, target, teamId, agent, rule);
}

/**
 * Team admins suspend or resume a site-wide agent for their team (AR9, §6.5): a gallery agent, a
 * site roster entry, or an assigned entry of this team's roster. Not found otherwise.
 */
export async function setTeamSuspension(
  db: KobeDb,
  actor: RosterActor,
  agentId: string,
  suspended: boolean,
): Promise<RosterResult<{ agentId: string; suspendedHere: boolean }>> {
  return withTeam(db, actor.teamId, async (tx) => {
    const [agent] = await tx
      .select({ id: siteAgents.id, slug: siteAgents.slug, scope: siteAgents.scope })
      .from(siteAgents)
      .where(eq(siteAgents.id, agentId))
      .for("share");
    if (!agent) return fail("agent_not_found");
    if (agent.scope === "personal") {
      const site = (await siteEntry(tx, agentId))?.state;
      const team = (await teamEntry(tx, actor.teamId, agentId))?.state;
      const runs = site === "active" || site === "suspended" || team === "active";
      if (!runs) return fail("agent_not_found");
    }
    const scope = agent.scope === "gallery" ? "gallery" : "personal";
    await setSuspendedHere(tx, actor, agentId, scope, suspended);
    await audit(tx, suspended ? "suspended" : "resumed", "team", actor.teamId, { ...agent, scope });
    return { ok: true, value: { agentId, suspendedHere: suspended } };
  });
}
