import { Hono } from "hono";
import { z } from "zod";
import {
  approvalResolutionCauseSchema,
  idSchema,
  uuidSchema as wireUuidSchema,
} from "@kobe/protocol";
import { sql, withTeam, type KobeTx } from "@kobe/db";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest } from "../teams/http.js";
import { viewerProjectIds } from "../threads/references.js";
import { findThread } from "../threads/repository.js";
import { uuidSchema } from "../threads/schemas.js";

/** Most rows of each kind one answer carries (newest kept; a thread rarely has more). */
export const MAX_MARKERS = 500;

const runMarkerSchema = z.strictObject({
  run_id: wireUuidSchema,
  status: z.enum(["interrupted", "budget_stopped"]),
  /** The prompt the run answered (Pi entry id), once mirrored; null if it never was. */
  user_entry_id: idSchema.nullable(),
  /** Where the run continued from; places a run whose prompt never reached the tree. */
  parent_entry_id: idSchema.nullable(),
});

const approvalMarkerSchema = z.strictObject({
  approval_id: wireUuidSchema,
  run_id: wireUuidSchema,
  /** The run's prompt entry: tool call ids are only unique per run, so it places the marker. */
  user_entry_id: idSchema.nullable(),
  tool_call_id: z.string(),
  status: z.enum(["allowed", "denied", "expired"]),
  /** Why it left pending: `user` decided, or the TTL, or the run ended (cancelled, …). */
  cause: approvalResolutionCauseSchema.nullable(),
});

export const threadMarkersSchema = z.strictObject({
  runs: z.array(runMarkerSchema),
  approvals: z.array(approvalMarkerSchema),
  /** True when a list held more than {@link MAX_MARKERS}: only the newest are returned. */
  truncated: z.boolean(),
});
export type ThreadMarkers = z.infer<typeof threadMarkersSchema>;

type Row = Record<string, unknown>;

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The newest {@link MAX_MARKERS} rows, oldest first, and whether there were more. */
function newest(rows: readonly Row[]): { rows: Row[]; truncated: boolean } {
  return { rows: rows.slice(0, MAX_MARKERS).reverse(), truncated: rows.length > MAX_MARKERS };
}

async function runMarkers(tx: KobeTx, teamId: string, threadId: string) {
  const res = await tx.execute<Row>(sql`
    SELECT id, status, user_entry_id, parent_entry_id
      FROM runs
     WHERE team_id = ${teamId}::uuid AND thread_id = ${threadId}::uuid
       AND status IN ('interrupted', 'budget_stopped') AND kind = 'message'
     ORDER BY created_at DESC, id DESC LIMIT ${MAX_MARKERS + 1}`);
  const { rows, truncated } = newest(res.rows);
  return {
    truncated,
    runs: rows.map((r) => ({
      run_id: String(r.id),
      status: r.status as "interrupted" | "budget_stopped",
      user_entry_id: text(r.user_entry_id),
      parent_entry_id: text(r.parent_entry_id),
    })),
  };
}

/**
 * Decided approvals of the thread whose asker is `userId` (the run's user, KOBE-37). Reached
 * through the thread's runs (`runs_thread_idx`, then `approvals_tool_call_key`'s
 * `(team_id, run_id)` prefix): `approvals` has no thread index, and the user's index would read
 * every approval they ever had in the team.
 */
async function approvalMarkers(tx: KobeTx, teamId: string, threadId: string, userId: string) {
  const res = await tx.execute<Row>(sql`
    SELECT a.id, a.run_id, r.user_entry_id, a.tool_call_id, a.status, a.cause
      FROM runs r
      JOIN approvals a ON a.team_id = r.team_id AND a.run_id = r.id
     WHERE r.team_id = ${teamId}::uuid AND r.thread_id = ${threadId}::uuid
       AND a.team_id = ${teamId}::uuid AND a.thread_id = ${threadId}::uuid
       AND a.user_id = ${userId}::uuid AND a.status <> 'pending'
     ORDER BY a.created_at DESC, a.id DESC LIMIT ${MAX_MARKERS + 1}`);
  const { rows, truncated } = newest(res.rows);
  return {
    truncated,
    approvals: rows.map((r) => {
      const cause = approvalResolutionCauseSchema.safeParse(r.cause);
      return {
        approval_id: String(r.id),
        run_id: String(r.run_id),
        user_entry_id: text(r.user_entry_id),
        tool_call_id: String(r.tool_call_id),
        status: r.status as "allowed" | "denied" | "expired",
        cause: cause.success ? cause.data : null,
      };
    }),
  };
}

/**
 * `GET /v1/threads/{id}/markers` (KOBE-209, CE12/CE16): what the chat marks between messages that
 * the entry tree doesn't hold: runs that ended `interrupted` or `budget_stopped`, and decided
 * approvals (outcome and cause only, never the checked input or reasons). Newest 500 of each,
 * oldest first; `truncated` says older ones were left out. Visible like the thread
 * (`findThread`); approvals only to the run's user, as `GET /v1/approvals` (a reader of a shared
 * thread gets none). Team-scoped under RLS. Reads Postgres only; never wakes a sandbox.
 */
export function threadMarkerRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.get("/:id/markers", async (c) => {
    const parsed = uuidSchema.safeParse(c.req.param("id"));
    if (!parsed.success) return invalidRequest(c);
    const threadId = parsed.data;
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const body = await withTeam(deps.database.db, teamId, async (tx) => {
      const viewer = { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) };
      if (!(await findThread(tx, viewer, threadId))) return null;
      const runs = await runMarkers(tx, teamId, threadId);
      const approvals = await approvalMarkers(tx, teamId, threadId, userId);
      return {
        runs: runs.runs,
        approvals: approvals.approvals,
        truncated: runs.truncated || approvals.truncated,
      } satisfies ThreadMarkers;
    });
    if (!body) return c.json({ code: "thread_not_found", message: "No thread with that id." }, 404);
    return c.json(body);
  });

  return app;
}
