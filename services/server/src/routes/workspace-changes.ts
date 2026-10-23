import type { Context, Hono } from "hono";
import { getMembership, sql, withTeam } from "@kobe/db";
import { workspaceChangesQuerySchema } from "@kobe/protocol";
import { teamRoleAllows } from "../authz/permissions.js";
import type { TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { createWorkspaceChangeStream } from "../workspace-files/change-stream.js";
import { readFileChanges } from "../workspace-files/changes.js";
import { isInternalPath } from "../workspace-files/paths.js";

type Ctx = Context<{ Variables: TeamVariables }>;

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
} as const;

/** Under @hono/node-server, `c.env.outgoing` is the Node response; destroying it drops the socket. */
function nodeResponseDestroyer(env: unknown): (() => void) | undefined {
  const outgoing = (env as { outgoing?: { destroy?: unknown } } | undefined)?.outgoing;
  if (!outgoing || typeof outgoing.destroy !== "function") return undefined;
  return () => (outgoing.destroy as () => void).call(outgoing);
}

/** The query as the contract reads it: `path` repeats; any other parameter is refused. */
function parseQuery(c: Ctx) {
  const params = new URL(c.req.url).searchParams;
  const raw: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    raw[key] = key === "path" ? params.getAll(key) : params.get(key);
  }
  return workspaceChangesQuerySchema.safeParse(raw);
}

/**
 * `GET /v1/workspace/changes?team=&path=…` (KOBE-496, contract `@kobe/protocol`
 * workspace-changes.ts): changes to the caller's own open files, live. Mounted inside the
 * workspace file routes, so `requireTeam` and `team.chat` already ran. Only the session's own
 * (team, user) rows are ever read (`readFileChanges`), so the stream can carry nothing of
 * another member or team, and a path the caller has no file at reads as "never seen", the same
 * answer as for a path that never existed. The viewer is rechecked every 30 s (session, role).
 */
export function registerWorkspaceChanges(
  app: Hono<{ Variables: TeamVariables }>,
  deps: ServerDeps,
) {
  const db = deps.database.db;
  app.get("/changes", async (c) => {
    const query = parseQuery(c);
    if (!query.success) {
      return c.json({ code: "invalid_path", message: "That is not a valid change request." }, 400);
    }
    const paths = [...new Set(query.data.path)];
    if (paths.some(isInternalPath)) {
      return c.json({ code: "invalid_path", message: "That is not a valid workspace path." }, 400);
    }
    const owner = { teamId: c.get("team").id, userId: c.get("user").id };
    if (query.data.team !== owner.teamId) {
      return c.json(
        {
          code: "team_mismatch",
          message: "Your active team changed in another tab. Reload to continue.",
          activeTeamId: owner.teamId,
        },
        409,
      );
    }
    const { hub, timings } = deps.eventStream;
    const release = hub.acquireSlot(owner.userId);
    if (!release) {
      return c.json(
        { code: "too_many_streams", message: "Too many open streams. Close a tab and retry." },
        429,
      );
    }
    const sessionId = c.get("sessionId");
    const body = createWorkspaceChangeStream({
      userId: owner.userId,
      paths,
      hub,
      timings,
      onEnd: release,
      abortConnection: nodeResponseDestroyer(c.env),
      source: {
        read: (after) =>
          withTeam(db, owner.teamId, (tx) => readFileChanges(tx, owner, paths, after)),
        async revalidate() {
          const live = await db.execute<{ live: boolean }>(
            sql`SELECT EXISTS (SELECT 1 FROM sessions WHERE id = ${sessionId}
                                AND expires_at > now()) AS live`,
          );
          if (live.rows[0]?.live !== true) return false;
          return teamRoleAllows(await getMembership(db, owner.teamId, owner.userId), "team.chat");
        },
      },
    });
    return new Response(body, { status: 200, headers: SSE_HEADERS });
  });
}
