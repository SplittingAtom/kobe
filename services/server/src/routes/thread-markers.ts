import { Hono } from "hono";
import { z } from "zod";
import {
  approvalResolutionCauseSchema,
  idSchema,
  timestampSchema,
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
const MAX_MARKERS = 500;

const runMarkerSchema = z.strictObject({
  run_id: wireUuidSchema,
  status: z.enum(["interrupted", "budget_stopped"]),
  /** The prompt the run answered (Pi entry id), once mirrored; null if it never was. */
  user_entry_id: idSchema.nullable(),
  /** Where the run continued from; places a run whose prompt never reached the tree. */
  parent_entry_id: idSchema.nullable(),
  ended_at: timestampSchema.nullable(),
});

const approvalMarkerSchema = z.strictObject({
  approval_id: wireUuidSchema,
  run_id: wireUuidSchema,
  tool_call_id: z.string(),
  status: z.enum(["allowed", "denied", "expired"]),
  cause: approvalResolutionCauseSchema.nullable(),
  decided_at: timestampSchema.nullable(),
});

export const threadMarkersSchema = z.strictObject({
  runs: z.array(runMarkerSchema),
  approvals: z.array(approvalMarkerSchema),
});
export type ThreadMarkers = z.infer<typeof threadMarkersSchema>;

type Row = Record<string, unknown>;

const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string | Date).toISOString();
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

async function runMarkers(tx: KobeTx, teamId: string, threadId: string) {
  const res = await tx.execute<Row>(sql`
    SELECT id, status, user_entry_id, parent_entry_id, ended_at FROM (
      SELECT id, status, user_entry_id, parent_entry_id, ended_at, created_at
        FROM runs
       WHERE team_id = ${teamId}::uuid AND thread_id = ${threadId}::uuid
         AND status IN ('interrupted', 'budget_stopped')
       ORDER BY created_at DESC LIMIT ${MAX_MARKERS}) r
     ORDER BY created_at`);
  return res.rows.map((r) => ({
    run_id: String(r.id),
    status: r.status as "interrupted" | "budget_stopped",
    user_entry_id: text(r.user_entry_id),
    parent_entry_id: text(r.parent_entry_id),
    ended_at: iso(r.ended_at),
  }));
}

/** Decided approvals of the thread whose asker is `userId` (the run's user, KOBE-37). */
async function approvalMarkers(tx: KobeTx, teamId: string, threadId: string, userId: string) {
  const res = await tx.execute<Row>(sql`
    SELECT id, run_id, tool_call_id, status, cause, decided_at FROM (
      SELECT id, run_id, tool_call_id, status, cause, decided_at, created_at
        FROM approvals
       WHERE team_id = ${teamId}::uuid AND thread_id = ${threadId}::uuid
         AND user_id = ${userId}::uuid AND status <> 'pending'
       ORDER BY created_at DESC LIMIT ${MAX_MARKERS}) a
     ORDER BY created_at, tool_call_id`);
  return res.rows.map((r) => {
    const cause = approvalResolutionCauseSchema.safeParse(r.cause);
    return {
      approval_id: String(r.id),
      run_id: String(r.run_id),
      tool_call_id: String(r.tool_call_id),
      status: r.status as "allowed" | "denied" | "expired",
      cause: cause.success ? cause.data : null,
      decided_at: iso(r.decided_at),
    };
  });
}

/**
 * `GET /v1/threads/{id}/markers` (KOBE-209, CE12/CE16): what the chat marks between messages that
 * the entry tree doesn't hold: runs that ended `interrupted` or `budget_stopped`, and decided
 * approvals (outcome only, never the checked input or reasons). Visible like the thread
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
      return {
        runs: await runMarkers(tx, teamId, threadId),
        approvals: await approvalMarkers(tx, teamId, threadId, userId),
      } satisfies ThreadMarkers;
    });
    if (!body) return c.json({ code: "thread_not_found", message: "No thread with that id." }, 404);
    return c.json(body);
  });

  return app;
}
