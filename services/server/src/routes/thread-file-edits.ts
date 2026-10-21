import { Hono } from "hono";
import { sql, withTeam } from "@kobe/db";
import {
  FILE_EDIT_PROPOSALS_MAX,
  fileEditProposedPayloadSchema,
  type FileEditProposal,
  type FileEditProposalsResponse,
} from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest } from "../teams/http.js";
import { viewerProjectIds } from "../threads/references.js";
import { findThread } from "../threads/repository.js";
import { uuidSchema } from "../threads/schemas.js";

const NOT_FOUND = { code: "thread_not_found", message: "No thread with that id." };

const iso = (value: Date | string) =>
  (value instanceof Date ? value : new Date(value)).toISOString();

/**
 * `GET /v1/threads/{id}/file-edit-proposals` (KOBE-462, file-editor.ts, spec FE9): the thread's
 * `propose_file_edit` proposals as the server recorded them (`file.edit_proposed` run events),
 * oldest first, newest {@link FILE_EDIT_PROPOSALS_MAX}. Only the thread's owner: a proposal is
 * about their workspace, which only they can commit to; anyone else gets the same 404.
 */
export function threadFileEditRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.get("/:id/file-edit-proposals", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const proposals = await withTeam(db, teamId, async (tx) => {
      const viewer = { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) };
      const found = await findThread(tx, viewer, id.data);
      if (found?.access !== "owner") return null;
      const res = await tx.execute<{
        run_id: string;
        payload: unknown;
        created_at: Date | string;
      }>(sql`
        SELECT e.run_id, e.payload, e.created_at FROM run_events e
          JOIN runs r ON r.team_id = e.team_id AND r.id = e.run_id
         WHERE e.team_id = ${teamId} AND r.team_id = ${teamId} AND r.thread_id = ${id.data}
           AND e.type = 'file.edit_proposed'
         ORDER BY e.created_at DESC, e.run_id DESC, e.seq DESC
         LIMIT ${FILE_EDIT_PROPOSALS_MAX}`);
      return res.rows.reverse().flatMap((row): FileEditProposal[] => {
        const payload = fileEditProposedPayloadSchema.safeParse(row.payload);
        return payload.success
          ? [{ ...payload.data, run_id: row.run_id, created_at: iso(row.created_at) }]
          : [];
      });
    });
    if (proposals === null) return c.json(NOT_FOUND, 404);
    const body: FileEditProposalsResponse = { proposals };
    c.header("cache-control", "private, no-store");
    return c.json(body);
  });

  return app;
}
