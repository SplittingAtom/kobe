import { Hono, type Context } from "hono";
import { withTeam } from "@kobe/db";
import {
  fileThreadsQuerySchema,
  listParameter,
  threadFileLinksQuerySchema,
  type FileThreadsResponse,
  type ThreadFileLinks,
  type ThreadFileLinksResponse,
} from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest } from "../teams/http.js";
import { linksOfThreads, threadsOfPaths } from "../thread-file-links/read.js";
import { viewerProjectIds } from "../threads/references.js";
import { findThread, findThreads, type Viewer } from "../threads/repository.js";
import { uuidSchema } from "../threads/schemas.js";

type Ctx = Context<{ Variables: TeamVariables }>;

const NOT_FOUND = { code: "thread_not_found", message: "No thread with that id." };

/** The one list parameter `name`, or undefined when absent or another parameter is present. */
function listQuery(c: Ctx, name: string): string[] | undefined {
  const params = new URL(c.req.url).searchParams;
  if ([...params.keys()].some((key) => key !== name)) return undefined;
  const values = params.getAll(name);
  return values.length === 0 ? undefined : listParameter(values);
}

async function viewerOf(c: Ctx, tx: Parameters<typeof viewerProjectIds>[0]): Promise<Viewer> {
  const teamId = c.get("team").id;
  const userId = c.get("user").id;
  return { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) };
}

function noStore<T>(c: Ctx, body: T) {
  c.header("cache-control", "private, no-store");
  return c.json(body);
}

/**
 * Thread–file links per thread (KOBE-611, contract `thread-file-links.ts`; privacy TFM7):
 * `GET /v1/threads/file-links?threads=…` for the visible rows in one call, and
 * `GET /v1/threads/{id}/file-links` for one thread. Only threads the viewer may read (the same
 * predicate as every thread read, `readableBy`); files named only in the viewer's own workspace or
 * a project they can read, the rest counted.
 */
export function threadFileLinkRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.get("/file-links", async (c) => {
    const threads = listQuery(c, "threads");
    const query = threadFileLinksQuerySchema.safeParse({ threads });
    if (!query.success) {
      return invalidRequest(c, "Name 1 to 50 thread ids in `threads`, separated by commas.");
    }
    const links = await withTeam(db, c.get("team").id, async (tx) => {
      const viewer = await viewerOf(c, tx);
      const readable = await findThreads(tx, viewer, query.data.threads);
      const ids = query.data.threads.filter((id) => readable.has(id));
      return linksOfThreads(tx, viewer, ids);
    });
    return noStore<ThreadFileLinksResponse>(c, { links });
  });

  app.get("/:id/file-links", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success || new URL(c.req.url).search !== "") return invalidRequest(c);
    const links = await withTeam(db, c.get("team").id, async (tx) => {
      const viewer = await viewerOf(c, tx);
      if ((await findThread(tx, viewer, id.data)) === null) return null;
      return (await linksOfThreads(tx, viewer, [id.data]))[0] ?? null;
    });
    if (links === null) return c.json(NOT_FOUND, 404);
    return noStore<ThreadFileLinks>(c, links);
  });

  return app;
}

/**
 * `GET /v1/workspace/file-threads?paths=…` (KOBE-611): for paths of the viewer's workspace tree,
 * the threads that used each, newest first; unreadable threads only counted (`more`).
 */
export function workspaceFileThreadRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.get("/file-threads", async (c) => {
    const paths = listQuery(c, "paths");
    const query = fileThreadsQuerySchema.safeParse({ paths });
    if (!query.success) {
      return invalidRequest(c, "Name 1 to 100 workspace paths in `paths`, separated by commas.");
    }
    const files = await withTeam(db, c.get("team").id, async (tx) =>
      threadsOfPaths(tx, await viewerOf(c, tx), query.data.paths),
    );
    return noStore<FileThreadsResponse>(c, { files });
  });

  return app;
}
