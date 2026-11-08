import {
  SYSTEM_ACTOR,
  and,
  eq,
  inArray,
  or,
  scanTeams,
  schedules,
  siteAgents,
  sql,
  teamAgentSuspensions,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { atCap, countActiveHere, nextDueAt } from "../schedules/store.js";
import type { ScheduleRecurrence } from "@kobe/protocol";
import { lentAgents, ownerStates } from "./roster-resolution.js";
import { SITE, toRecord } from "./store.js";
import { canPinAgent } from "./versions.js";

/**
 * Schedules follow the roster (KOBE-567, spec agents-roster AR11). A schedule that runs someone
 * else's personal agent (lent by the team or site roster) or a gallery agent is paused with
 * `paused_by = agent_unavailable` when that agent can no longer start a thread for the schedule's
 * owner in the team: removed or withdrawn from the roster, suspended there, archived, or its
 * owner left or was deactivated. The owner is told (`schedule.paused`). It resumes once the agent
 * is back. Owners' own pauses and team admins' pauses are never touched; neither are schedules of
 * owners who are themselves inactive (the owner sweep turns those into `deactivation`, which an
 * agent coming back never resumes). Idempotent: called by roster writes, member removal and on
 * every scheduler tick (`sweepAgentSchedules`), which catches what the others could not do in
 * their transaction (site writes, deactivation, an owner rejoining).
 */

export interface AgentScheduleChanges {
  readonly paused: readonly string[];
  readonly resumed: readonly string[];
}

/** Which agents to look at: some agents, an owner's agents, or every site-wide agent. */
export type AgentScheduleFilter =
  | { readonly agentIds: readonly string[] }
  | { readonly agentOwner: string }
  | Record<string, never>;

/**
 * Pauses or resumes the team's schedules of lent and gallery agents (see above), inside
 * `withTeam(teamId)`. Team-owned agents keep their own status rules (AR9).
 * Rows a fire or an owner edit holds are skipped (`SKIP LOCKED`): the next tick retries.
 */
export async function syncAgentSchedules(
  tx: KobeTx,
  teamId: string,
  filter: AgentScheduleFilter = {},
): Promise<AgentScheduleChanges> {
  if ("agentIds" in filter && filter.agentIds.length === 0) return { paused: [], resumed: [] };
  const rows = await tx
    .select({
      id: schedules.id,
      userId: schedules.userId,
      agentId: schedules.agentId,
      active: schedules.active,
      recurrence: schedules.recurrence,
      tz: schedules.tz,
    })
    .from(schedules)
    .innerJoin(siteAgents, eq(siteAgents.id, schedules.agentId))
    .where(
      and(
        eq(schedules.teamId, teamId),
        or(eq(schedules.active, true), eq(schedules.pausedBy, "agent_unavailable")),
        sql`${siteAgents.ownerUserId} IS DISTINCT FROM ${schedules.userId}`,
        "agentIds" in filter ? inArray(schedules.agentId, [...filter.agentIds]) : undefined,
        "agentOwner" in filter ? eq(siteAgents.ownerUserId, filter.agentOwner) : undefined,
      ),
    )
    .for("update", { of: schedules, skipLocked: true });
  if (rows.length === 0) return { paused: [], resumed: [] };
  const owners = await ownerStates(
    tx,
    teamId,
    rows.map((r) => r.userId),
  );
  const startable = await startableHere(tx, teamId, [...new Set(rows.map((r) => r.agentId))]);
  const paused: string[] = [];
  const resumed: string[] = [];
  for (const row of rows) {
    const owner = owners.get(row.userId);
    if (!owner?.member || owner.deactivated) continue;
    const runnable = startable.has(row.agentId);
    if (row.active && !runnable) {
      await pause(tx, teamId, row);
      paused.push(row.id);
    } else if (!row.active && runnable && (await resume(tx, teamId, row))) {
      resumed.push(row.id);
    }
  }
  return { paused, resumed };
}

/** Nobody's id: `lentAgents` then excludes no owner (schedules of own agents are not synced). */
const NOBODY = "00000000-0000-0000-0000-000000000000";

/**
 * Which of `agentIds` can start a thread in the team for a member who does not own them, computed
 * once per call: lent personal agents (`lentAgents`, at their version in effect) and gallery
 * agents, active here (team and site-wide suspensions), not archived, published.
 */
async function startableHere(
  tx: KobeTx,
  teamId: string,
  agentIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const wanted = new Set(agentIds);
  const lent = (await lentAgents(tx, { teamId, userId: NOBODY }))
    .map((l) => l.record)
    .filter((r) => wanted.has(r.id));
  const gallery = await tx
    .select(SITE)
    .from(siteAgents)
    .where(and(inArray(siteAgents.id, [...wanted]), eq(siteAgents.scope, "gallery")));
  const here = new Set(
    (
      await tx
        .select({ id: teamAgentSuspensions.agentId })
        .from(teamAgentSuspensions)
        .where(eq(teamAgentSuspensions.teamId, teamId))
    ).map((r) => r.id),
  );
  const galleryRecords = gallery.map((r) => {
    const record = toRecord("gallery", r);
    return here.has(record.id) ? { ...record, status: "suspended" as const } : record;
  });
  return new Set([...lent, ...galleryRecords].filter(canPinAgent).map((r) => r.id));
}

interface ScheduleRow {
  readonly id: string;
  readonly userId: string;
  readonly recurrence: Record<string, unknown>;
  readonly tz: string;
}

async function pause(tx: KobeTx, teamId: string, row: ScheduleRow): Promise<void> {
  await tx
    .update(schedules)
    .set({ active: false, pausedBy: "agent_unavailable", nextDueAt: null, updatedAt: new Date() })
    .where(and(eq(schedules.teamId, teamId), eq(schedules.id, row.id)));
  // The existing `schedule.paused` notification (KOBE-177 contract); in-app only, no email yet.
  await tx.execute(sql`
    INSERT INTO notifications (team_id, user_id, kind, schedule_id, paused_by)
    VALUES (${teamId}, ${row.userId}, 'schedule.paused', ${row.id}, 'agent_unavailable')`);
  await recordAudit(tx, {
    action: "schedule.deactivated",
    actor: SYSTEM_ACTOR,
    teamId,
    target: { scheduleId: row.id, by: "agent_unavailable" },
  });
}

/** False when it can't resume now: no next occurrence, or the owner is at the cap in this team. */
async function resume(tx: KobeTx, teamId: string, row: ScheduleRow): Promise<boolean> {
  const due = nextDueAt(row.recurrence as ScheduleRecurrence, row.tz);
  if (due === null || atCap(await countActiveHere(tx, teamId, row.userId))) return false;
  await tx
    .update(schedules)
    .set({ active: true, pausedBy: null, nextDueAt: due, updatedAt: new Date() })
    .where(and(eq(schedules.teamId, teamId), eq(schedules.id, row.id)));
  await recordAudit(tx, {
    action: "schedule.activated",
    actor: SYSTEM_ACTOR,
    teamId,
    target: { scheduleId: row.id, by: "agent_available" },
  });
  return true;
}

/**
 * After a site roster write (no team transaction): every team's schedules of `agentId`. Must not
 * run inside a team transaction. A failure is left to the next scheduler tick.
 */
export async function syncAgentSchedulesEverywhere(
  db: KobeDb,
  agentId: string,
): Promise<AgentScheduleChanges> {
  const perTeam = await scanTeams(db, "syncAgentSchedulesEverywhere", (tx, team) =>
    syncAgentSchedules(tx, team.id, { agentIds: [agentId] }),
  );
  return {
    paused: perTeam.flatMap((c) => c.paused),
    resumed: perTeam.flatMap((c) => c.resumed),
  };
}

/** The scheduler tick's pass over one team (`scheduler/runner.ts`). */
export function sweepAgentSchedules(db: KobeDb, teamId: string): Promise<AgentScheduleChanges> {
  return withTeam(db, teamId, (tx) => syncAgentSchedules(tx, teamId));
}
