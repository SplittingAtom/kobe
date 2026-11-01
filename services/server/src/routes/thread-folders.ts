import type { Context } from "hono";
import { Hono } from "hono";
import { isLockTimeout, withTeam, type KobeTx } from "@kobe/db";
import {
  createThreadFolderRequestSchema,
  THREAD_FOLDER_ERROR_HTTP_STATUS,
  updateThreadFolderRequestSchema,
} from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { hitRateLimit } from "../rate-limit.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import {
  createFolder,
  deleteFolder,
  FOLDER_CREATE_RATE,
  folderErrorOf,
  listFolders,
  updateFolder,
  type FolderError,
  type FolderResult,
} from "../threads/folders.js";
import { viewerProjectIds } from "../threads/references.js";
import type { Viewer } from "../threads/repository.js";
import { uuidSchema } from "../threads/schemas.js";

type FolderContext = Context<{ Variables: TeamVariables }>;

const MESSAGES = {
  folder_not_found: "No folder with that id in this team.",
  folder_name_taken: "A folder with that name is already there. Choose another name.",
  folder_too_deep: "Folders go three levels deep.",
  folder_cycle: "A folder can't be moved inside itself or one of its folders.",
  folder_limit: "This team has the most folders it can have (500). Delete some first.",
} as const satisfies Record<FolderError, string>;

function fail(c: Context, code: FolderError | "rate_limited" | "folder_busy") {
  if (code === "rate_limited") {
    return c.json(
      { code, message: "Too many new folders. Wait a few minutes and try again." },
      429,
    );
  }
  if (code === "folder_busy") {
    return c.json({ code, message: "The folders are being changed. Try again." }, 409);
  }
  return c.json({ code, message: MESSAGES[code] }, THREAD_FOLDER_ERROR_HTTP_STATUS[code]);
}

function folderIdParam(c: Context): string | undefined {
  const parsed = uuidSchema.safeParse(c.req.param("id"));
  return parsed.success ? parsed.data : undefined;
}

/**
 * Thread folders (KOBE-534, spec TF4): `GET/POST /v1/thread-folders`, `PATCH/DELETE
 * /v1/thread-folders/{id}`, for any member of the active team (`team.chat`); the logic is
 * `threads/folders.ts`. Every route runs in `withTeam`, so another team's folder answers 404.
 */
export function threadFolderRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  const asViewer = <T>(c: FolderContext, fn: (tx: KobeTx, viewer: Viewer) => Promise<T>) => {
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    return withTeam(db, teamId, async (tx) =>
      fn(tx, { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) }),
    );
  };

  /** Runs a change; the tree trigger's and the name key's refusals become their codes. */
  const change = async <T>(
    c: FolderContext,
    fn: (tx: KobeTx, viewer: Viewer) => Promise<FolderResult<T>>,
  ): Promise<FolderResult<T> | Response> => {
    try {
      return await asViewer(c, fn);
    } catch (err) {
      const code = folderErrorOf(err);
      if (code) return fail(c, code);
      if (isLockTimeout(err)) return fail(c, "folder_busy");
      throw err;
    }
  };

  app.get("/", async (c) => c.json({ folders: await asViewer(c, listFolders) }));

  app.post("/", async (c) => {
    const body = await parseBody(c, createThreadFolderRequestSchema);
    if (!body)
      return invalidRequest(c, "Give a name (1-80 characters) and, inside a folder, parent_id.");
    if (!(await hitRateLimit(db, `folder-create:${c.get("user").id}`, FOLDER_CREATE_RATE))) {
      return fail(c, "rate_limited");
    }
    const result = await change(c, (tx, viewer) =>
      createFolder(tx, viewer, { name: body.name, parentId: body.parent_id ?? null }),
    );
    if (result instanceof Response) return result;
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });

  app.patch("/:id", async (c) => {
    const id = folderIdParam(c);
    const body = await parseBody(c, updateThreadFolderRequestSchema);
    if (!id || !body) return invalidRequest(c, "Give name, parent_id and/or position.");
    const result = await change(c, (tx, viewer) =>
      updateFolder(tx, viewer, id, {
        name: body.name,
        parentId: body.parent_id,
        position: body.position,
      }),
    );
    if (result instanceof Response) return result;
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  app.delete("/:id", async (c) => {
    const id = folderIdParam(c);
    if (!id) return invalidRequest(c);
    const result = await change(c, (tx, viewer) => deleteFolder(tx, viewer, id));
    if (result instanceof Response) return result;
    return result.ok ? c.body(null, 204) : fail(c, result.error);
  });

  return app;
}
