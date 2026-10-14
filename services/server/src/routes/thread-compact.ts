import { Hono } from "hono";
import {
  COMPACT_THREAD_ERROR_HTTP_STATUS,
  compactThreadError,
  compactThreadRequestSchema,
} from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { CompactionError } from "../runs/compaction.js";
import { RunError } from "../runs/errors.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { uuidSchema } from "../threads/schemas.js";

/**
 * `POST /v1/threads/{id}/compact` (KOBE-213, CE15; contract KOBE-212): the owner compacts an idle
 * thread's Pi session, optionally with a one-line focus for the summary. Answers 200 once Pi wrote
 * the summary (its `compaction` entry is then in the thread's entries, unless Pi's new entries
 * exceed one wire frame: then they are mirrored as the next run starts), or a fixed message per
 * code; another team's thread, or one the member can't see, is 404 and a shared reader's 403
 * (`read_only`), as for messages. Waits for Pi (a slow command, up to its 10 min).
 */
export function threadCompactRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.post("/:id/compact", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    const body = await parseBody(c, compactThreadRequestSchema);
    if (!id.success || !body) return invalidRequest(c, "Give an optional one-line focus, or {}.");
    const team = c.get("team");
    try {
      const result = await deps.runs.compact(
        {
          user_id: c.get("user").id,
          team_id: team.id,
          site_role: c.get("siteRole") ?? "user",
          team_role: team.role,
        },
        id.data,
        body.focus,
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof CompactionError) {
        return c.json(compactThreadError(err.code), COMPACT_THREAD_ERROR_HTTP_STATUS[err.code]);
      }
      // A thread row held past the lock timeout: the contract's own busy answer.
      if (err instanceof RunError && err.code === "thread_busy") {
        return c.json(
          compactThreadError("thread_busy"),
          COMPACT_THREAD_ERROR_HTTP_STATUS.thread_busy,
        );
      }
      if (err instanceof RunError) {
        return c.json({ code: err.code, message: err.message }, err.status as 400);
      }
      throw err;
    }
  });

  return app;
}
