import { Hono } from "hono";
import { withTeam } from "@kobe/db";
import { syncConflictActionBodySchema, type ThreadSyncConflictsResponse } from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  listThreadConflicts,
  listWorkspaceConflicts,
  settleConflict,
} from "../sync-conflicts/store.js";
import { invalidRequest } from "../teams/http.js";
import { viewerProjectIds } from "../threads/references.js";
import { findThread } from "../threads/repository.js";
import { uuidSchema } from "../threads/schemas.js";

const NOT_FOUND = { code: "thread_not_found", message: "No thread with that id." };
const CONFLICT_NOT_FOUND = { code: "conflict_not_found", message: "No such sync conflict." };

/**
 * Workspace sync conflicts of a thread (KOBE-492, contract sync-conflicts.ts). Only the thread's
 * owner: a conflict is about their own workspace, so anyone else gets the same 404.
 *
 * - `GET /v1/threads/{id}/sync-conflicts`: unresolved, undismissed conflicts, newest first.
 * - `POST /v1/threads/{id}/sync-conflicts/{conflict_id}` `{action}`: `resolved` (the member
 *   deleted the copy) or `dismissed`; 204, idempotent.
 */
export function threadSyncConflictRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.get("/:id/sync-conflicts", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const conflicts = await withTeam(db, teamId, async (tx) => {
      const viewer = { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) };
      const found = await findThread(tx, viewer, id.data);
      if (found?.access !== "owner") return null;
      return listThreadConflicts(tx, { teamId, userId }, id.data);
    });
    if (conflicts === null) return c.json(NOT_FOUND, 404);
    const body: ThreadSyncConflictsResponse = { conflicts };
    c.header("cache-control", "private, no-store");
    return c.json(body);
  });

  app.post("/:id/sync-conflicts/:conflictId", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    const conflictId = uuidSchema.safeParse(c.req.param("conflictId"));
    const body = syncConflictActionBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !conflictId.success || !body.success) return invalidRequest(c);
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const outcome = await withTeam(db, teamId, async (tx) => {
      const viewer = { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) };
      const found = await findThread(tx, viewer, id.data);
      if (found?.access !== "owner") return "no_thread" as const;
      const settled = await settleConflict(
        tx,
        { teamId, userId },
        id.data,
        conflictId.data,
        body.data.action,
      );
      return settled ? ("ok" as const) : ("no_conflict" as const);
    });
    if (outcome === "no_thread") return c.json(NOT_FOUND, 404);
    if (outcome === "no_conflict") return c.json(CONFLICT_NOT_FOUND, 404);
    return c.body(null, 204);
  });

  return app;
}

/**
 * The caller's own sync conflicts no thread wrote (KOBE-492): shown in the Files rail, so every
 * conflict reaches its member. Same shapes as the thread routes.
 *
 * - `GET /v1/workspace/sync-conflicts`
 * - `POST /v1/workspace/sync-conflicts/{conflict_id}` `{action}`: 204, idempotent.
 */
export function workspaceSyncConflictRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.get("/sync-conflicts", async (c) => {
    const owner = { teamId: c.get("team").id, userId: c.get("user").id };
    const conflicts = await withTeam(db, owner.teamId, (tx) => listWorkspaceConflicts(tx, owner));
    const body: ThreadSyncConflictsResponse = { conflicts };
    c.header("cache-control", "private, no-store");
    return c.json(body);
  });

  app.post("/sync-conflicts/:conflictId", async (c) => {
    const conflictId = uuidSchema.safeParse(c.req.param("conflictId"));
    const body = syncConflictActionBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!conflictId.success || !body.success) return invalidRequest(c);
    const owner = { teamId: c.get("team").id, userId: c.get("user").id };
    const settled = await withTeam(db, owner.teamId, (tx) =>
      settleConflict(tx, owner, null, conflictId.data, body.data.action),
    );
    if (!settled) return c.json(CONFLICT_NOT_FOUND, 404);
    return c.body(null, 204);
  });

  return app;
}
