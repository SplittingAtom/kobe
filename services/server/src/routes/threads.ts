import type { Context } from "hono";
import { Hono } from "hono";
import type { z } from "zod";
import { withTeam, type KobeTx } from "@kobe/db";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import {
  decodeActivityCursor,
  encodeActivityCursor,
  type ActivityCursor,
} from "../threads/cursor.js";
import { canCreateInProject, resolveAgentPin, viewerProjectIds } from "../threads/references.js";
import {
  createThread,
  findThread,
  isLockTimeout,
  listEntries,
  listThreads,
  listTrash,
  restoreThread,
  setLeaf,
  toSummary,
  trashThread,
  updateThread,
  type Page,
  type ThreadError,
  type ThreadResult,
  type Viewer,
} from "../threads/repository.js";
import {
  createThreadBodySchema,
  entriesQuerySchema,
  listThreadsQuerySchema,
  setLeafBodySchema,
  trashQuerySchema,
  updateThreadBodySchema,
  uuidSchema,
  type ThreadSummary,
} from "../threads/schemas.js";
import { searchThreadList } from "../threads/search.js";

type ThreadContext = Context<{ Variables: TeamVariables }>;

const ERRORS = {
  thread_not_found: [404, "No thread with that id."],
  entry_not_found: [404, "That entry is not part of this thread."],
  agent_not_found: [404, "No agent with that id is available in this team."],
  project_not_found: [404, "No project with that id is available to you."],
  read_only: [403, "This thread is shared with you read-only."],
  thread_busy: [
    409,
    "The thread is busy (a run is active or queued, or it is being written). Try again.",
  ],
  thread_in_trash: [409, "The thread is in Trash. Restore it first."],
  not_in_trash: [409, "The thread is not in Trash."],
  not_in_project: [409, "Only threads in a project can be shared to it."],
  invalid_cursor: [400, "The cursor is not valid. Start from the first page."],
  invalid_query: [400, "The search needs at least one term that is not excluded with -."],
  search_timeout: [503, "The search took too long. Try more specific terms."],
} as const satisfies Record<string, readonly [number, string]>;

type ErrorCode = keyof typeof ERRORS;

function fail(c: Context, code: ErrorCode) {
  const [status, message] = ERRORS[code];
  return c.json({ code, message }, status);
}

function parseQuery<T>(c: Context, schema: z.ZodType<T>): T | undefined {
  const parsed = schema.safeParse(c.req.query());
  return parsed.success ? parsed.data : undefined;
}

/** The thread id path parameter, normalized to lowercase; undefined when it is not a uuid. */
function threadIdParam(c: Context): string | undefined {
  const parsed = uuidSchema.safeParse(c.req.param("id"));
  return parsed.success ? parsed.data : undefined;
}

/** The cursor, null for the first page, or undefined when it is malformed. */
function cursorParam(raw: string | undefined): ActivityCursor | null | undefined {
  if (raw === undefined) return null;
  return decodeActivityCursor(raw) ?? undefined;
}

function pageBody(page: Page<ThreadSummary>) {
  return {
    threads: page.items,
    next_cursor: page.next ? encodeActivityCursor(page.next) : null,
  };
}

/**
 * Thread API (spec §6.1, D9, D15, D18, D23): create, list (keyset pagination), read with entries,
 * rename, share to project, switch branch (leaf), Trash and restore. Team-scoped: the team comes
 * from the session's active team (never from the request), every query runs in `withTeam`, and
 * every route needs `team.chat`. Reads touch only Postgres and never wake a sandbox (D14, U15).
 * Messages and runs (`POST /v1/threads/{id}/messages`, `/v1/runs/*`) belong to the run
 * orchestrator (KOBE-30). Search (`?q=`) is `threads/search.ts` (KOBE-33).
 */
export function threadRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  /** Runs `fn` in the active team's transaction as the signed-in viewer. */
  const asViewer = <T>(c: ThreadContext, fn: (tx: KobeTx, viewer: Viewer) => Promise<T>) => {
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    return withTeam(db, teamId, async (tx) =>
      fn(tx, { teamId, userId, projectIds: await viewerProjectIds(tx, userId) }),
    );
  };

  /** Runs a change; a thread row held past the lock timeout answers 409 `thread_busy`. */
  const change = async (
    c: ThreadContext,
    fn: (tx: KobeTx, viewer: Viewer) => Promise<ThreadResult>,
  ) => {
    try {
      const result = await asViewer(c, fn);
      return result.ok ? c.json(result.thread) : fail(c, result.error satisfies ThreadError);
    } catch (err) {
      if (isLockTimeout(err)) return fail(c, "thread_busy");
      throw err;
    }
  };

  app.get("/", async (c) => {
    const query = parseQuery(c, listThreadsQuerySchema);
    if (!query) return invalidRequest(c);
    if (query.q !== undefined) {
      const { q, project_id, cursor, limit } = query;
      const result = await asViewer(c, (tx, viewer) =>
        searchThreadList(tx, viewer, { query: q, projectId: project_id, cursor, limit }),
      );
      return result.ok ? c.json(result.body) : fail(c, result.error);
    }
    const cursor = cursorParam(query.cursor);
    if (cursor === undefined) return fail(c, "invalid_cursor");
    const page = await asViewer(c, (tx, viewer) =>
      listThreads(tx, viewer, { projectId: query.project_id, cursor, limit: query.limit }),
    );
    return c.json(pageBody(page));
  });

  app.get("/trash", async (c) => {
    const query = parseQuery(c, trashQuerySchema);
    if (!query) return invalidRequest(c);
    const cursor = cursorParam(query.cursor);
    if (cursor === undefined) return fail(c, "invalid_cursor");
    const page = await asViewer(c, (tx, viewer) =>
      listTrash(tx, viewer, { cursor, limit: query.limit }),
    );
    return c.json(pageBody(page));
  });

  app.post("/", async (c) => {
    const body = await parseBody(c, createThreadBodySchema);
    if (!body) return invalidRequest(c, "Give agent_id, project_id and title only, as ids/text.");
    const result = await asViewer(c, async (tx, viewer) => {
      const projectId = body.project_id ?? null;
      if (projectId !== null && !(await canCreateInProject(tx, viewer.userId, projectId))) {
        return "project_not_found" as const;
      }
      const pin = await resolveAgentPin(tx, viewer.userId, body.agent_id ?? null);
      if (pin === undefined) return "agent_not_found" as const;
      return createThread(tx, {
        teamId: viewer.teamId,
        ownerUserId: viewer.userId,
        projectId,
        agentId: pin?.agentId ?? null,
        agentVersion: pin?.agentVersion ?? null,
        title: body.title ?? null,
      });
    });
    return typeof result === "string" ? fail(c, result) : c.json(result, 201);
  });

  app.get("/:id", async (c) => {
    const id = threadIdParam(c);
    const query = parseQuery(c, entriesQuerySchema);
    if (!id || !query) return invalidRequest(c);
    const detail = await asViewer(c, async (tx, viewer) => {
      const found = await findThread(tx, viewer, id);
      if (!found) return null;
      const page = await listEntries(tx, viewer, id, query.after, query.limit);
      return {
        ...toSummary(found.thread),
        entries: page.entries,
        next_entries_after: page.nextAfter,
      };
    });
    return detail ? c.json(detail) : fail(c, "thread_not_found");
  });

  app.get("/:id/entries", async (c) => {
    const id = threadIdParam(c);
    const query = parseQuery(c, entriesQuerySchema);
    if (!id || !query) return invalidRequest(c);
    const page = await asViewer(c, async (tx, viewer) => {
      if (!(await findThread(tx, viewer, id))) return null;
      return listEntries(tx, viewer, id, query.after, query.limit);
    });
    return page
      ? c.json({ entries: page.entries, next_entries_after: page.nextAfter })
      : fail(c, "thread_not_found");
  });

  app.patch("/:id", async (c) => {
    const id = threadIdParam(c);
    const body = await parseBody(c, updateThreadBodySchema);
    if (!id || !body) return invalidRequest(c, "Give title and/or shared_to_project.");
    return change(c, (tx, viewer) => updateThread(tx, viewer, id, body));
  });

  app.post("/:id/leaf", async (c) => {
    const id = threadIdParam(c);
    const body = await parseBody(c, setLeafBodySchema);
    if (!id || !body) return invalidRequest(c, "Give the entry_id to continue from.");
    return change(c, (tx, viewer) => setLeaf(tx, viewer, id, body.entry_id));
  });

  app.delete("/:id", async (c) => {
    const id = threadIdParam(c);
    if (!id) return invalidRequest(c);
    return change(c, (tx, viewer) => trashThread(tx, viewer, id));
  });

  app.post("/:id/restore", async (c) => {
    const id = threadIdParam(c);
    if (!id) return invalidRequest(c);
    return change(c, (tx, viewer) => restoreThread(tx, viewer, id));
  });

  return app;
}
