import { Hono } from "hono";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { deleteReleasedBlobs } from "../retention/blobs.js";
import { deleteForever, type DeleteForeverError } from "../retention/delete-forever.js";
import { exportResponseBody, recordExport } from "../retention/export.js";
import { blobRecorder } from "../retention/job.js";
import { isLockTimeout } from "../threads/repository.js";
import { uuidSchema } from "../threads/schemas.js";
import { invalidRequest } from "../teams/http.js";

const ERRORS = {
  thread_not_found: [404, "No thread with that id."],
  not_in_trash: [
    409,
    "Only conversations in Trash can be deleted for good. Move it to Trash first.",
  ],
  thread_busy: [409, "The thread is busy (a run is active or queued). Try again."],
} as const satisfies Record<DeleteForeverError, readonly [number, string]>;

/** Users exporting right now on this replica: one export at a time per user. */
const exporting = new Set<string>();
/** Exports streaming at once on one replica (each holds a DB connection per page and S3 reads). */
export const MAX_EXPORTS_PER_REPLICA = 4;
/** Browsers mark a navigation another site started; a download must come from Kobe's own page. */
const SAME_SITE_FETCH = new Set(["same-origin", "none"]);

/**
 * The user's own retention actions on threads (spec D18): "Delete forever" from Trash and the
 * export of their threads in the active team. Team-scoped (`team.chat`); both act only on threads
 * the signed-in user owns — team admins get nothing more here (D18: they can't read or delete
 * members' threads). Mounted before the thread API so `/export` isn't taken for a thread id.
 */
export function threadRetentionRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.post("/:id/purge", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    const teamId = c.get("team").id;
    let result;
    try {
      result = await deleteForever(db, { teamId, userId: c.get("user").id }, id.data);
    } catch (err) {
      if (isLockTimeout(err)) {
        const [status, message] = ERRORS.thread_busy;
        return c.json({ code: "thread_busy", message }, status);
      }
      throw err;
    }
    if (!result.ok) {
      const [status, message] = ERRORS[result.error];
      return c.json({ code: result.error, message }, status);
    }
    const blobs = deps.blobs;
    if (result.purged && blobs) {
      deps.background.run(
        "released blobs could not be deleted (the nightly pass retries)",
        () => deleteReleasedBlobs(db, teamId, blobs, blobRecorder(teamId), { maxBatches: 10 }),
        { teamId },
      );
    }
    return c.body(null, 204);
  });

  /**
   * `GET /v1/threads/export` → zip. A download link can't send `X-Kobe-Team`, so the team the
   * page believes is active comes as `?team=` and must match the session's (stale-tab guard).
   */
  app.get("/export", async (c) => {
    // CSRF: a GET skips the Origin check, so refuse downloads another site starts (each would
    // write an audit row and stream a whole export).
    const site = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    if (
      (site !== undefined && !SAME_SITE_FETCH.has(site)) ||
      (origin !== undefined && origin !== deps.publicUrl)
    ) {
      return c.json({ code: "forbidden_origin", message: "Cross-origin request rejected." }, 403);
    }
    const team = c.get("team");
    const claimed = c.req.query("team");
    if (claimed !== undefined && claimed !== team.id) {
      return c.json(
        {
          code: "team_mismatch",
          message: "Your active team changed in another tab. Reload to continue.",
          activeTeamId: team.id,
        },
        409,
      );
    }
    const userId = c.get("user").id;
    if (exporting.has(userId) || exporting.size >= MAX_EXPORTS_PER_REPLICA) {
      return c.json(
        {
          code: "export_in_progress",
          message: "An export is already running. Try again when it has finished.",
        },
        429,
      );
    }
    // Claimed before any await, so concurrent requests can't both pass the checks above.
    exporting.add(userId);
    const viewer = { teamId: team.id, userId };
    try {
      await recordExport(db, viewer);
    } catch (err) {
      exporting.delete(userId);
      throw err;
    }
    const body = exportResponseBody(db, viewer, deps.blobs);
    // Released when the stream ends, fails or the client goes away.
    const done = () => exporting.delete(userId);
    const reader = body.getReader();
    const tracked = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done: finished } = await reader.read();
          if (finished) {
            done();
            controller.close();
          } else controller.enqueue(value);
        } catch (err) {
          done();
          logger.error({ err, teamId: team.id }, "thread export failed");
          controller.error(err);
        }
      },
      async cancel(reason) {
        done();
        await reader.cancel(reason);
      },
    });
    const day = new Date().toISOString().slice(0, 10);
    return new Response(tracked, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="kobe-${team.slug}-${day}.zip"`,
        "cache-control": "no-store",
      },
    });
  });

  return app;
}
