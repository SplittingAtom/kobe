import { Hono, type Context } from "hono";
import { withTeam } from "@kobe/db";
import { appResultViews, readAppResult } from "../apps/thread-results.js";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest } from "../teams/http.js";
import { viewerProjectIds } from "../threads/references.js";
import { findThread } from "../threads/repository.js";
import { uuidSchema } from "../threads/schemas.js";

/**
 * MCP Apps in the conversation (KOBE-438, spec MA10), visible like the thread (`findThread`:
 * its owner, and readers once shared), each viewer acting as themselves (T12):
 *
 * - `GET /v1/threads/{id}/app-results`: the thread's results as this viewer sees them, the live
 *   app or the text card with its reason (`apps/thread-results.ts`); newest 500, oldest first.
 * - `GET /v1/threads/{id}/app-results/{ref}`: one stored result `{result}`, only when the viewer
 *   may open it as an app now (409 `text_only` otherwise). JSON only: `no-store`, `nosniff`,
 *   `default-src 'none'`. Reads Postgres and the thread's own S3 tree; never the upstream.
 */
const NOT_FOUND = { code: "not_found", message: "No such app result in this thread." };

export function threadAppResultRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  app.use("/:id/app-results/*", headers);
  app.use("/:id/app-results", headers);

  const visible = <T>(
    c: Context<{ Variables: TeamVariables }>,
    threadId: string,
    fn: (tx: Parameters<Parameters<typeof withTeam>[2]>[0]) => Promise<T>,
  ) => {
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    return withTeam(db, teamId, async (tx) => {
      const viewer = { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) };
      if (!(await findThread(tx, viewer, threadId))) return null;
      return { value: await fn(tx) };
    });
  };

  app.get("/:id/app-results", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    const ids = { teamId: c.get("team").id, userId: c.get("user").id, threadId: id.data };
    const found = await visible(c, id.data, (tx) => appResultViews(db, tx, ids));
    if (!found)
      return c.json({ code: "thread_not_found", message: "No thread with that id." }, 404);
    return c.json(found.value);
  });

  app.get("/:id/app-results/:ref", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    const ref = uuidSchema.safeParse(c.req.param("ref"));
    if (!id.success || !ref.success) return invalidRequest(c);
    const ids = { teamId: c.get("team").id, userId: c.get("user").id, threadId: id.data };
    const found = await visible(c, id.data, (tx) =>
      readAppResult(db, tx, deps.blobs, ids, ref.data, c.req.raw.signal),
    );
    if (!found)
      return c.json({ code: "thread_not_found", message: "No thread with that id." }, 404);
    const read = found.value;
    if (read.ok) return c.json({ result: read.result });
    if (read.code === "not_found") return c.json(NOT_FOUND, 404);
    if (read.code === "text_only") {
      return c.json({ code: "text_only", message: "This app shows as text for you." }, 409);
    }
    return c.json(
      { code: "result_unavailable", message: "The app's result is unavailable. Try again." },
      503,
    );
  });

  return app;
}

async function headers(c: Context, next: () => Promise<void>): Promise<void> {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Security-Policy", "default-src 'none'");
}
