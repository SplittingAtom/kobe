import { and, eq, sql, teamAgentSuspensions, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { z } from "zod";
import { recordAudit } from "../audit/record.js";
import { findAgent, setAgentStatus, type AgentRecord } from "./store.js";

/**
 * Agent inventory for team admins (KOBE-86, spec D19): the team's agents plus the install-wide
 * agents (members' personal agents, gallery agents) that threads of this team have used, with
 * usage counts. Every query states `team_id` explicitly, on top of `withTeam()` (break-glass
 * policy). A personal agent is install-wide data, so a team admin suspends it for this team only
 * (`team_agent_suspensions`); team agents use their own `status`.
 */

export const INVENTORY_PAGE_DEFAULT = 50;
export const INVENTORY_PAGE_MAX = 200;

const CURSOR = /^([a-z0-9-]{1,47}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

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
  /** Effective status in this team: suspended here or install-wide. */
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
  /** KOBE-64 (schedules) is not built: always null. */
  readonly schedules: null;
  /** Orbit scores arrive with KOBE-52: always null. */
  readonly orbitScore: null;
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
};

/** Raw SQL returns timestamps as the driver parses them (Date or text). */
const iso = (v: Date | string | null): string | null =>
  v === null ? null : new Date(v).toISOString();

export function toInventoryItem(r: InventoryRow): InventoryItem {
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
    schedules: null,
    orbitScore: null,
  };
}

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
   WHERE i.id IN (
     SELECT t.agent_id FROM threads t
      WHERE t.team_id = ${teamId} AND t.agent_scope IN ('personal', 'gallery')
        AND t.agent_id IS NOT NULL)`;

export async function listInventory(
  db: KobeDb,
  teamId: string,
  query: z.infer<typeof inventoryQuerySchema>,
): Promise<InventoryPage> {
  const limit = query.limit ?? INVENTORY_PAGE_DEFAULT;
  const match = query.cursor ? CURSOR.exec(query.cursor) : null;
  const after = match ? sql`WHERE (inv.slug, inv.id) > (${match[1]}, ${match[2]}::uuid)` : sql``;
  const rows = await withTeam(db, teamId, async (tx) => {
    const result = await tx.execute<InventoryRow>(sql`
      WITH inv AS (${inventoryRows(teamId)}),
      page AS (SELECT inv.* FROM inv ${after} ORDER BY inv.slug, inv.id LIMIT ${limit + 1})
      SELECT page.*, u.name AS owner_name, runs.run_count, runs.last_run_at, usage.tokens
        FROM page
        LEFT JOIN users u ON u.id = page.owner_user_id
        CROSS JOIN LATERAL (
          SELECT count(*) AS run_count, max(r.created_at) AS last_run_at
            FROM threads t JOIN runs r ON r.team_id = t.team_id AND r.thread_id = t.id
           WHERE t.team_id = ${teamId} AND r.team_id = ${teamId} AND t.agent_id = page.id) runs
        CROSS JOIN LATERAL (
          SELECT coalesce(sum(ru.input_tokens + ru.output_tokens), 0) AS tokens
            FROM run_usage ru WHERE ru.team_id = ${teamId} AND ru.agent_id = page.id) usage
       ORDER BY page.slug, page.id`);
    return result.rows;
  });
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    agents: pageRows.map(toInventoryItem),
    nextCursor: rows.length > limit && last ? `${last.slug}:${last.id}` : null,
  };
}

/** An install-wide agent this team's threads use (the only ones a team may suspend). */
async function usedInstallAgent(
  tx: KobeTx,
  teamId: string,
  id: string,
): Promise<{ slug: string; scope: "personal" | "gallery" } | null> {
  const result = await tx.execute<{ slug: string; scope: "personal" | "gallery" }>(sql`
    SELECT i.slug, i.scope::text AS scope FROM install_agents i
     WHERE i.id = ${id}::uuid AND EXISTS (
       SELECT 1 FROM threads t WHERE t.team_id = ${teamId} AND t.agent_id = i.id
         AND t.agent_scope IN ('personal', 'gallery'))`);
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
    const agent = await usedInstallAgent(tx, teamId, id);
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

/** True when the team suspended this install-wide agent (run start and pinning check it). */
export async function suspendedInTeam(tx: KobeTx, teamId: string, id: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: teamAgentSuspensions.agentId })
    .from(teamAgentSuspensions)
    .where(and(eq(teamAgentSuspensions.teamId, teamId), eq(teamAgentSuspensions.agentId, id)));
  return row !== undefined;
}
