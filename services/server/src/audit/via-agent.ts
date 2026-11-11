import { AUDIT_VIA_AGENT_KEY, sql, withTeam, type KobeDb } from "@kobe/db";
import { findThreads } from "../threads/repository.js";
import { viewerProjectIds } from "../threads/references.js";

/**
 * "via agent" in the audit views (KOBE-623, spec kobe-admin-mcp §7): an event a person caused
 * through a Kobe MCP admin tool carries `target.viaAgent` (thread, run, tool call). The views say
 * so, and link the thread only for a viewer who may read it now: a member of its team who owns it
 * or has it shared with them (the thread rules of `readableBy`). Ids only otherwise.
 */

export interface ViaAgentView {
  readonly threadId: string;
  readonly runId: string;
  readonly toolCallId: string;
  /** The viewer may open the thread (`/?thread=<id>` in its team). */
  readonly threadOpen: boolean;
}

interface ViaAgent {
  readonly threadId: string;
  readonly runId: string;
  readonly toolCallId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The event's via-agent record, when it has a well-formed one. */
export function viaAgentOf(target: Record<string, unknown>): ViaAgent | undefined {
  const via = target[AUDIT_VIA_AGENT_KEY];
  if (via === null || typeof via !== "object") return undefined;
  // Stored without its `kind` (agent is the only one): `{threadId, runId, toolCallId}`.
  const { threadId, runId, toolCallId } = via as Record<string, unknown>;
  if (typeof threadId !== "string" || !UUID.test(threadId)) return undefined;
  if (typeof runId !== "string" || typeof toolCallId !== "string") return undefined;
  return { threadId, runId, toolCallId };
}

interface Event {
  readonly id: string;
  readonly teamId: string | null;
  readonly target: Record<string, unknown>;
}

/** The threads among `ids` of `teamId` that `userId` may read now (none unless a member). */
async function openThreads(
  db: KobeDb,
  teamId: string,
  userId: string,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  return withTeam(db, teamId, async (tx) => {
    const member = await tx.execute<{ one: number }>(sql`
      SELECT 1 AS one FROM public.team_members m JOIN public.users u ON u.id = m.user_id
       WHERE m.team_id = ${teamId} AND m.user_id = ${userId} AND u.deactivated_at IS NULL`);
    if (member.rows.length === 0) return new Set<string>();
    const viewer = { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) };
    return new Set((await findThreads(tx, viewer, ids)).keys());
  });
}

/** Each event's via-agent view by event id, for `userId` reading the log. */
export async function viaAgentViews(
  db: KobeDb,
  userId: string,
  events: readonly Event[],
): Promise<Map<string, ViaAgentView>> {
  const byTeam = new Map<string, Set<string>>();
  const found: [Event, ViaAgent][] = [];
  for (const e of events) {
    const via = viaAgentOf(e.target);
    if (via === undefined) continue;
    found.push([e, via]);
    if (e.teamId !== null)
      byTeam.set(e.teamId, (byTeam.get(e.teamId) ?? new Set()).add(via.threadId));
  }
  const open = new Map<string, ReadonlySet<string>>();
  for (const [teamId, ids] of byTeam)
    open.set(teamId, await openThreads(db, teamId, userId, [...ids]));
  return new Map(
    found.map(([e, via]) => [
      e.id,
      {
        ...via,
        threadOpen: e.teamId !== null && (open.get(e.teamId)?.has(via.threadId) ?? false),
      },
    ]),
  );
}

/** The page's events with `viaAgent` added where one applies (the rest unchanged). */
export async function withViaAgent<E extends Event>(
  db: KobeDb,
  userId: string,
  events: readonly E[],
): Promise<(E & { viaAgent?: ViaAgentView })[]> {
  const views = await viaAgentViews(db, userId, events);
  return events.map((e) => {
    const view = views.get(e.id);
    return view === undefined ? e : { ...e, viaAgent: view };
  });
}
