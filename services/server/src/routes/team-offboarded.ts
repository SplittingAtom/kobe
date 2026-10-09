import { Readable } from "node:stream";
import { Hono } from "hono";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { invalidRequest } from "../teams/http.js";
import { idSchema } from "../teams/schemas.js";

/**
 * Departed members' workspaces (`/v1/team/offboarded`, spec D12, KOBE-28), team admins only. When a
 * member is removed or deactivated their sandbox is destroyed at once and the workspace is kept
 * for 30 days: the list shows who is still exportable and until when; the export is a zip of the
 * workspace files (every download is audited). After the 30 days it is gone (unless a legal hold
 * covers the member).
 */
export function teamOffboardedRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.members.manage"));

  app.get("/", async (c) => c.json({ members: await deps.offboarding.list(c.get("team").id) }));

  app.get("/:userId/export", async (c) => {
    const userId = idSchema.safeParse(c.req.param("userId"));
    if (!userId.success) return invalidRequest(c);
    const started = await deps.offboarding.startExport(c.get("team").id, userId.data);
    if (started.kind === "unavailable") {
      return c.json(
        { code: "export_unavailable", message: "Workspace storage is not configured." },
        503,
      );
    }
    if (started.kind === "not_found") {
      return c.json(
        {
          code: "not_exportable",
          message:
            "No retained workspace for that member (never had one, or the 30 days are over).",
        },
        404,
      );
    }
    const body = Readable.from(started.chunks);
    body.on("error", (err) => logger.error({ err }, "offboarding export aborted"));
    return c.body(Readable.toWeb(body) as ReadableStream, 200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="workspace-${userId.data}.zip"`,
      "cache-control": "no-store",
    });
  });

  return app;
}
