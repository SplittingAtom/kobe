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
import {
  agentStatusOf,
  findPinnableAgent,
  latestPinnedVersion,
  resolveAgentPin,
  resolveDraftPin,
} from "../agents/versions.js";
import { forkThreadRequestSchema, shareThreadRequestSchema } from "@kobe/protocol";
import { forkThread } from "../threads/fork.js";
import { sharedToProjectFor } from "../threads/share.js";
import { projectDefaultAgent } from "../projects/run-context.js";
import { canCreateInProject, viewerProjectIds } from "../threads/references.js";
import {
  clearTestThreads,
  createThread,
  findThread,
  isLockTimeout,
  listEntries,
  listThreads,
  listTrash,
  restoreThread,
  setLeaf,
  switchAgentVersion,
  toSummary,
  trashThread,
  updateThread,
  type Page,
  type ThreadError,
  type ThreadResult,
  type Viewer,
} from "../threads/repository.js";
import {
  clearTestThreadsQuerySchema,
  createThreadBodySchema,
  entriesQuerySchema,
  listThreadsQuerySchema,
  setLeafBodySchema,
  switchAgentVersionBodySchema,
  trashQuerySchema,
  updateThreadBodySchema,
  uuidSchema,
  type ThreadSummary,
} from "../threads/schemas.js";
import { searchThreadList } from "../threads/search.js";
import { isModelEnabled } from "../models/team-store.js";

type ThreadContext = Context<{ Variables: TeamVariables }>;

const ERRORS = {
  thread_not_found: [404, "No thread with that id."],
  entry_not_found: [404, "That entry is not part of this thread."],
  entry_offloaded: [
    409,
    "This conversation has very large messages that can't be copied into a fork yet.",
  ],
  agent_not_found: [404, "No agent with that id is available in this team."],
  agent_unavailable: [
    409,
    "That agent can't start conversations: it is suspended, archived or not published yet.",
  ],
  version_not_found: [404, "That agent has no such published version."],
  model_not_enabled: [
    409,
    "That model isn't enabled for your team. Pick one of the team's models, or ask a team admin.",
  ],
  no_agent: [409, "This thread uses the default agent, which has no versions to switch."],
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
      fn(tx, { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) }),
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

  // Before `/:id`: clears the caller's own builder test threads (KOBE-85).
  app.delete("/test", async (c) => {
    const query = parseQuery(c, clearTestThreadsQuerySchema);
    if (!query) return invalidRequest(c, "agent_id must be an agent id.");
    const cleared = await asViewer(c, (tx, viewer) =>
      clearTestThreads(tx, viewer, { agentId: query.agent_id }),
    );
    return c.json({ cleared });
  });

  app.post("/", async (c) => {
    const body = await parseBody(c, createThreadBodySchema);
    if (!body) {
      return invalidRequest(c, "Give agent_id, project_id, title, model and test only.");
    }
    const test = body.test === true;
    if (test && (!body.agent_id || body.project_id)) {
      return invalidRequest(c, "A test thread needs an agent_id and has no project.");
    }
    const actor = { userId: c.get("user").id, role: c.get("team").role };
    const result = await asViewer(c, async (tx, viewer) => {
      const projectId = body.project_id ?? null;
      if (projectId !== null && !(await canCreateInProject(tx, viewer, projectId))) {
        return "project_not_found" as const;
      }
      // D19: the thread pins the agent's current published version.
      // A test thread (KOBE-85) pins the agent's draft instead: only for those who can edit it.
      const pin =
        test && body.agent_id
          ? await resolveDraftPin(tx, viewer, actor, body.agent_id)
          : await resolveAgentPin(
              tx,
              viewer,
              body.agent_id ?? (await projectDefaultAgent(tx, viewer, projectId)),
            );
      if (!pin.ok) return pin.error;
      const model = body.model ?? null;
      if (model !== null && !(await isModelEnabled(tx, viewer.teamId, model))) {
        return "model_not_enabled" as const;
      }
      return createThread(tx, {
        teamId: viewer.teamId,
        ownerUserId: viewer.userId,
        projectId,
        agent: pin.value,
        isTest: test,
        title: body.title ?? null,
        modelAlias: model,
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
      const latest = await latestPinnedVersion(tx, { teamId: viewer.teamId, ...found.thread });
      // KOBE-44: the agent's model pin (KOBE-47 seam), which wins over the thread's `model`.
      const agentModel = await deps.runAgents.pinnedModel?.(tx, {
        teamId: viewer.teamId,
        ownerUserId: found.thread.ownerUserId,
        threadId: found.thread.id,
        agentScope: found.thread.agentScope,
        agentId: found.thread.agentId,
        agentVersion: found.thread.agentVersion,
      });
      const pinned = found.thread.agentId
        ? await findPinnableAgent(
            tx,
            {
              teamId: viewer.teamId,
              userId: found.thread.ownerUserId,
            },
            found.thread.agentId,
          )
        : null;
      return {
        ...toSummary(found.thread),
        read_only: found.access !== "owner",
        agent_name: pinned?.frontmatter.name ?? null,
        agent_status: pinned === null ? null : agentStatusOf(pinned),
        agent_current_version: latest,
        agent_model: agentModel ?? null,
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
    if (!id || !body) return invalidRequest(c, "Give title, shared_to_project and/or model.");
    return change(c, (tx, viewer) => updateThread(tx, viewer, id, body));
  });

  app.post("/:id/share", async (c) => {
    const id = threadIdParam(c);
    const body = await parseBody(c, shareThreadRequestSchema);
    if (!id || !body) return invalidRequest(c, "Give visibility: private or project.");
    return change(c, (tx, viewer) =>
      updateThread(tx, viewer, id, { shared_to_project: sharedToProjectFor(body.visibility) }),
    );
  });

  app.post("/:id/fork", async (c) => {
    const id = threadIdParam(c);
    const body = await parseBody(c, forkThreadRequestSchema);
    if (!id || !body) return invalidRequest(c, "Give entry_id and/or title (or {}).");
    const result = await asViewer(c, (tx, viewer) =>
      forkThread(tx, viewer, id, { entryId: body.entry_id, title: body.title }),
    );
    return result.ok ? c.json({ thread_id: result.thread.thread_id }, 201) : fail(c, result.error);
  });

  app.post("/:id/leaf", async (c) => {
    const id = threadIdParam(c);
    const body = await parseBody(c, setLeafBodySchema);
    if (!id || !body) return invalidRequest(c, "Give the entry_id to continue from.");
    return change(c, (tx, viewer) => setLeaf(tx, viewer, id, body.entry_id));
  });

  app.post("/:id/agent-version", async (c) => {
    const id = threadIdParam(c);
    const body = await parseBody(c, switchAgentVersionBodySchema);
    if (!id || !body) return invalidRequest(c, "Give the version to switch to, or nothing.");
    return change(c, (tx, viewer) => switchAgentVersion(tx, viewer, id, body.version));
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
