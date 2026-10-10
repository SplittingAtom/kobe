import { Hono } from "hono";
import { z } from "zod";
import { idSchema, runStatusSchema, uuidSchema as wireUuidSchema } from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { threadRunRows } from "../runs/store.js";
import { invalidRequest } from "../teams/http.js";
import { viewerProjectIds } from "../threads/references.js";
import { findThread } from "../threads/repository.js";
import { uuidSchema } from "../threads/schemas.js";

/**
 * One message the thread holds outside its entry tree: a queued run's message (D17, editable) or
 * the active run's message until Pi commits it as an entry. `content` is the text as sent (or as
 * last edited); `parent_entry_id` is the branch point (null until the run starts and continues
 * from the leaf).
 */
export const pendingMessageSchema = z.strictObject({
  run_id: wireUuidSchema,
  status: runStatusSchema,
  /** Position among the thread's queued runs (1 = next); absent unless queued. */
  queue_pos: z.number().int().positive().optional(),
  content: z.string(),
  parent_entry_id: idSchema.nullable(),
});

export const pendingMessagesSchema = z.strictObject({
  messages: z.array(pendingMessageSchema),
});
export type PendingMessages = z.infer<typeof pendingMessagesSchema>;

/**
 * `GET /v1/threads/{id}/pending-messages` (KOBE-32): the text of the thread's queued messages and
 * of its active run's prompt, which `GET /v1/threads/{id}/runs` (run snapshots) doesn't carry. The
 * web client needs it to show and edit the queue and to show the prompt of a run in progress after
 * a reload or on another device (U4), before Pi commits it as an entry. Visible like the thread
 * (KOBE-34 `findThread`); queued messages only to the owner, a reader of a shared thread sees the
 * active run's prompt only. Team-scoped under RLS. Reads Postgres only; never wakes a sandbox.
 */
export function threadPendingRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.get("/:id/pending-messages", async (c) => {
    const parsed = uuidSchema.safeParse(c.req.param("id"));
    if (!parsed.success) return invalidRequest(c);
    const threadId = parsed.data;
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const body = await withTeam(deps.database.db, teamId, async (tx) => {
      const viewer = { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) };
      const found = await findThread(tx, viewer, threadId);
      if (!found) return null;
      const owner = found.access === "owner";
      const rows = await threadRunRows(tx, teamId, threadId);
      return {
        messages: rows
          // Queued messages are the owner's drafts (editable, maybe deleted): readers of a shared
          // thread see only the prompt of the run in progress, as they will in its entries.
          .filter((r) => (r.status === "queued" ? owner : r.userEntryId === null))
          .map((r) => ({
            run_id: r.id,
            status: r.status,
            ...(r.queueRank !== null ? { queue_pos: r.queueRank } : {}),
            content: r.input,
            parent_entry_id: r.parentEntryId,
          })),
      } satisfies PendingMessages;
    });
    if (!body) return c.json({ code: "thread_not_found", message: "No thread with that id." }, 404);
    return c.json(body);
  });

  return app;
}
