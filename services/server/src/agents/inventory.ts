import { and, eq, sql, teamAgentSuspensions, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { AGENT_SLUG_MAX } from "@kobe/agent-file";
import { z } from "zod";
import { recordAudit } from "../audit/record.js";
import { findAgent, setAgentStatus, type AgentRecord } from "./store.js";

/**
 * Agent inventory for team admins (KOBE-86, spec D19): the team's agents plus the site-wide
 * agents (members' personal agents, gallery agents) that threads or schedules of this team use,
 * with usage counts and the team's schedules per agent (KOBE-180). Every query states `team_id`
 * explicitly, on top of `withTeam()` (break-glass policy). A personal agent is site-wide data, so a team admin suspends it for this team only
 * (`team_agent_suspensions`); team agents use their own `status`.
 */

export const INVENTORY_PAGE_DEFAULT = 50;
export const INVENTORY_PAGE_MAX = 200;

const CURSOR = new RegExp(
  `^([a-z0-9-]{1,${AGENT_SLUG_MAX}}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`,
);

/** `GET /inventory`: keyset pages ordered by (slug, id); `cursor` is the previous `nextCursor`. */
export const inventoryQuerySchema = z
  .object({
    cursor: z.string().regex(CURSOR).optional(),
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(INVENTORY_PAGE_MAX))
      .optional(),
  })
  .strict();

export interface InventoryItem {
  readonly id: string;
  readonly scope: "team" | "personal" | "gallery";
  readonly slug: string;
  readonly name: string;
  readonly ownerUserId: string | null;
  readonly ownerName: string | null;
  /** Effective status in this team: suspended here or site-wide. */
  readonly status: "active" | "suspended";
  readonly archivedAt: string | null;
  readonly currentVersion: number | null;
  /** Versions only grow (a rollback republishes), so the newest number is the count. */
  readonly versionCount: number;
  /** Runs of this team's threads pinned to the agent (any version). */
  readonly runCount: number;
  readonly lastRunAt: string | null;
  /** Input plus output tokens of the team's attributed model calls (`run_usage`); no money. */
  readonly tokens: number;
  /** This team's schedules of the agent, any owner, oldest first (KOBE-180). */
  readonly schedules: readonly InventorySchedule[];
  /** The latest Orbit score (KOBE-94). */
  readonly orbitScore: InventoryScore;
}

/** A schedule as the inventory shows it: who owns it and whether it fires. */
export interface InventorySchedule {
  readonly scheduleId: string;
  readonly ownerUserId: string;
  readonly ownerName: string;
  readonly status: "active" | "paused";
  /** Why it is paused when the owner did not pause it: a team admin, or deactivation/removal. */
  readonly pausedBy: "team_admin" | "deactivation" | null;
  readonly nextDueAt: string | null;
}

/**
 * Latest Orbit result of an agent. Team and personal agents: this team's newest eval (`evaluating`
 * while one runs, `errored` when it could not finish, so no rate); a personal agent evaluated in
 * another team shows `none` here. Gallery agents: the site-level score of the current version.
 */
export interface InventoryScore {
  readonly status: "none" | "evaluating" | "passed" | "blocked" | "errored";
  readonly attackSuccessRate: number | null;
  /** When the result came in (the eval's start while evaluating); null for none. */
  readonly at: string | null;
}

export interface InventoryPage {
  readonly agents: readonly InventoryItem[];
  readonly nextCursor: string | null;
}

type InventoryRow = {
  id: string;
  scope: InventoryItem["scope"];
  slug: string;
  name: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  status: InventoryItem["status"];
  archived_at: Date | string | null;
  current_version: number | null;
  run_count: string;
  last_run_at: Date | string | null;
  tokens: string;
  score_status: string | null;
  score_rate: number | null;
  score_at: Date | string | null;
};

const SCORE_STATUS: Readonly<Record<string, InventoryScore["status"]>> = {
  pending: "evaluating",
  running: "evaluating",
  passed: "passed",
  blocked: "blocked",
  errored: "errored",
};

/** Raw SQL returns timestamps as the driver parses them (Date or text). */
const iso = (v: Date | string | null): string | null =>
  v === null ? null : new Date(v).toISOString();

export function toInventoryItem(
  r: InventoryRow,
  schedules: readonly InventorySchedule[] = [],
): InventoryItem {
  return {
    id: r.id,
    scope: r.scope,
    slug: r.slug,
    name: r.name ?? r.slug,
    ownerUserId: r.owner_user_id,
    ownerName: r.owner_name,
    status: r.status,
    archivedAt: iso(r.archived_at),
    currentVersion: r.current_version,
    versionCount: r.current_version ?? 0,
    runCount: Number(r.run_count),
    lastRunAt: iso(r.last_run_at),
    tokens: Number(r.tokens),
    schedules,
    orbitScore: {
      status: (r.score_status && SCORE_STATUS[r.score_status]) || "none",
      attackSuccessRate: r.score_rate,
      at: iso(r.score_at),
    },
  };
}

/** Site-wide agents this team uses: pinned by a live thread or by a schedule (KOBE-180). */
const usedSiteAgentIds = (teamId: string) => sql`
  SELECT t.install_agent_id FROM threads t
   WHERE t.team_id = ${teamId} AND t.install_agent_id IS NOT NULL AND t.deleted_at IS NULL
     AND NOT t.is_test
  UNION
  SELECT s.agent_id FROM schedules s WHERE s.team_id = ${teamId}`;

/** The agents of the inventory (before paging), as a CTE body over `${teamId}`. */
const inventoryRows = (teamId: string) => sql`
  SELECT 'team' AS scope, a.id, a.slug, a.frontmatter->>'name' AS name, a.owner_user_id,
         a.status::text AS status, a.current_version, a.archived_at
    FROM team_agents a WHERE a.team_id = ${teamId}
  UNION ALL
  SELECT i.scope::text, i.id, i.slug, i.frontmatter->>'name', i.owner_user_id,
         CASE WHEN i.status = 'suspended' OR s.agent_id IS NOT NULL THEN 'suspended' ELSE 'active' END,
         i.current_version, i.archived_at
    FROM install_agents i
    LEFT JOIN team_agent_suspensions s ON s.team_id = ${teamId} AND s.agent_id = i.id
   WHERE i.id IN (${usedSiteAgentIds(teamId)})`;

export async function listInventory(
  db: KobeDb,
  teamId: string,
  query: z.infer<typeof inventoryQuerySchema>,
): Promise<InventoryPage> {
  const limit = query.limit ?? INVENTORY_PAGE_DEFAULT;
  const match = query.cursor ? CURSOR.exec(query.cursor) : null;
  const after = match ? sql`WHERE (inv.slug, inv.id) > (${match[1]}, ${match[2]}::uuid)` : sql``;
  const { more, pageRows, scheduled } = await withTeam(db, teamId, async (tx) => {
    const result = await tx.execute<InventoryRow>(sql`
      WITH inv AS (${inventoryRows(teamId)}),
      page AS (SELECT inv.* FROM inv ${after} ORDER BY inv.slug, inv.id LIMIT ${limit + 1}),
      thread_runs AS (
        SELECT page.id AS agent_id, count(r.id) AS run_count, max(r.created_at) AS last_run_at
          FROM page
          JOIN LATERAL (
            SELECT t.id FROM threads t WHERE t.team_id = ${teamId} AND t.team_agent_id = page.id AND NOT t.is_test
            UNION ALL
            SELECT t.id FROM threads t WHERE t.team_id = ${teamId} AND t.install_agent_id = page.id AND NOT t.is_test
          ) th ON true
          JOIN runs r ON r.team_id = ${teamId} AND r.thread_id = th.id
         GROUP BY page.id),
      usage AS (
        SELECT ru.agent_id, sum(ru.input_tokens + ru.output_tokens) AS tokens
          FROM run_usage ru
         WHERE ru.team_id = ${teamId} AND ru.agent_id IN (SELECT id FROM page)
         GROUP BY ru.agent_id),
      team_score AS (
        SELECT DISTINCT ON (e.agent_id) e.agent_id, e.status, e.attack_success_rate AS rate,
               coalesce(e.finished_at, e.started_at, e.created_at) AS at
          FROM orbit_evals e
         WHERE e.team_id = ${teamId} AND e.agent_scope <> 'gallery'
           AND e.agent_id IN (SELECT id FROM page WHERE scope <> 'gallery')
         ORDER BY e.agent_id, e.created_at DESC),
      gallery_score AS (
        SELECT DISTINCT ON (g.agent_id) g.agent_id, g.status, g.attack_success_rate AS rate,
               g.evaluated_at AS at
          FROM gallery_agent_scores g
          JOIN page ON page.id = g.agent_id AND page.scope = 'gallery'
                   AND page.current_version = g.version
         ORDER BY g.agent_id, g.evaluated_at DESC)
      SELECT page.*, u.name AS owner_name, coalesce(tr.run_count, 0) AS run_count,
             tr.last_run_at, coalesce(usage.tokens, 0) AS tokens,
             coalesce(ts.status, gs.status) AS score_status,
             coalesce(ts.rate, gs.rate) AS score_rate, coalesce(ts.at, gs.at) AS score_at
        FROM page
        LEFT JOIN users u ON u.id = page.owner_user_id
        LEFT JOIN thread_runs tr ON tr.agent_id = page.id
        LEFT JOIN usage ON usage.agent_id = page.id
        LEFT JOIN team_score ts ON ts.agent_id = page.id
        LEFT JOIN gallery_score gs ON gs.agent_id = page.id
       ORDER BY page.slug, page.id`);
    const pageRows = result.rows.slice(0, limit);
    const scheduled = await schedulesOf(
      tx,
      teamId,
      pageRows.map((r) => r.id),
    );
    return { more: result.rows.length > limit, pageRows, scheduled };
  });
  const last = pageRows.at(-1);
  return {
    agents: pageRows.map((r) => toInventoryItem(r, scheduled.get(r.id))),
    nextCursor: more && last ? `${last.slug}:${last.id}` : null,
  };
}

type ScheduleRow = {
  id: string;
  agent_id: string;
  user_id: string;
  owner_name: string;
  active: boolean;
  paused_by: InventorySchedule["pausedBy"];
  next_due_at: Date | string | null;
};

/** The team's schedules of these agents, grouped by agent (RLS and an explicit `team_id`). */
async function schedulesOf(
  tx: KobeTx,
  teamId: string,
  agentIds: readonly string[],
): Promise<ReadonlyMap<string, readonly InventorySchedule[]>> {
  if (agentIds.length === 0) return new Map();
  const result = await tx.execute<ScheduleRow>(sql`
    SELECT s.id, s.agent_id, s.user_id, u.name AS owner_name, s.active, s.paused_by, s.next_due_at
      FROM schedules s JOIN users u ON u.id = s.user_id
     WHERE s.team_id = ${teamId}
       AND s.agent_id IN (${sql.join(
         agentIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     ORDER BY s.created_at, s.id`);
  const grouped = new Map<string, InventorySchedule[]>();
  for (const r of result.rows) {
    const item: InventorySchedule = {
      scheduleId: r.id,
      ownerUserId: r.user_id,
      ownerName: r.owner_name,
      status: r.active ? "active" : "paused",
      pausedBy: r.paused_by,
      nextDueAt: iso(r.next_due_at),
    };
    grouped.set(r.agent_id, [...(grouped.get(r.agent_id) ?? []), item]);
  }
  return grouped;
}

/** A site-wide agent this team's threads or schedules use (the only ones a team may suspend). */
async function usedSiteAgent(
  tx: KobeTx,
  teamId: string,
  id: string,
): Promise<{ slug: string; scope: "personal" | "gallery" } | null> {
  const result = await tx.execute<{ slug: string; scope: "personal" | "gallery" }>(sql`
    SELECT i.slug, i.scope::text AS scope FROM install_agents i
     WHERE i.id = ${id}::uuid AND i.id IN (${usedSiteAgentIds(teamId)})`);
  return result.rows[0] ?? null;
}

export type SuspendResult =
  { ok: true; scope: AgentRecord["scope"] } | { ok: false; error: "not_found" };

/**
 * Suspends or reactivates an agent for the team (audited): a team agent through its own status,
 * a used personal or gallery agent through this team's suspension row. Anything else is not found.
 */
export async function setInventoryStatus(
  db: KobeDb,
  teamId: string,
  actorUserId: string,
  id: string,
  status: "active" | "suspended",
): Promise<SuspendResult> {
  const own = await findAgent(db, { scope: "team", teamId }, id);
  if (own) {
    const updated = await setAgentStatus(db, { scope: "team", teamId }, id, status);
    return updated ? { ok: true, scope: "team" } : { ok: false, error: "not_found" };
  }
  return withTeam(db, teamId, async (tx): Promise<SuspendResult> => {
    const agent = await usedSiteAgent(tx, teamId, id);
    if (!agent) return { ok: false, error: "not_found" };
    if (status === "suspended") {
      await tx
        .insert(teamAgentSuspensions)
        .values({ teamId, agentId: id, agentScope: agent.scope, suspendedBy: actorUserId })
        .onConflictDoNothing();
    } else {
      await tx
        .delete(teamAgentSuspensions)
        .where(and(eq(teamAgentSuspensions.teamId, teamId), eq(teamAgentSuspensions.agentId, id)));
    }
    await recordAudit(tx, {
      action: "agent.status_changed",
      teamId,
      target: { agentId: id, scope: agent.scope, slug: agent.slug, status },
    });
    return { ok: true, scope: agent.scope };
  });
}

/** True when the team suspended this site-wide agent (run start and pinning check it). */
export async function suspendedInTeam(tx: KobeTx, teamId: string, id: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: teamAgentSuspensions.agentId })
    .from(teamAgentSuspensions)
    .where(and(eq(teamAgentSuspensions.teamId, teamId), eq(teamAgentSuspensions.agentId, id)));
  return row !== undefined;
}
