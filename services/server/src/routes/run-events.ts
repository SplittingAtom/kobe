import { Hono } from "hono";
import { z } from "zod";
import { decideStreamOpen, resolveResumeCursor } from "@kobe/protocol";
import { getMembership, sessions, sql, eq, and } from "@kobe/db";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { loadRun, readPage } from "../event-stream/read.js";
import { createRunEventStream, type StreamSource } from "../event-stream/stream.js";
import { canWatchThread } from "../event-stream/visibility.js";

const uuid = z.uuid();

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
} as const;

/** Whether the Better Auth session still exists and has not expired. */
async function sessionIsLive(deps: ServerDeps, sessionId: string): Promise<boolean> {
  const rows = await deps.database.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), sql`${sessions.expiresAt} > now()`));
  return rows.length > 0;
}

/** Under @hono/node-server, `c.env.outgoing` is the Node response; destroying it drops the socket. */
function nodeResponseDestroyer(env: unknown): (() => void) | undefined {
  const outgoing = (env as { outgoing?: { destroy?: unknown } } | undefined)?.outgoing;
  if (!outgoing || typeof outgoing.destroy !== "function") return undefined;
  return () => (outgoing.destroy as () => void).call(outgoing);
}

/**
 * Kobe Event Stream (spec §6.1 `GET /v1/runs/{id}/events`, §6.2, D16). Scoped to the active team
 * (D9); a run is visible to whoever may read its thread. Unknown runs, other teams' runs and
 * teammates' private runs all answer the same 404, so the endpoint is no existence oracle.
 */
export function runEventsRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  const { hub, timings } = deps.eventStream;
  app.use(requireTeam(deps));

  app.get("/:runId/events", requireTeamPermission("team.chat"), async (c) => {
    const notFound = () => c.json({ code: "not_found", message: "Run not found." }, 404);
    const runId = c.req.param("runId").toLowerCase();
    if (!uuid.safeParse(runId).success) return notFound();
    const cursor = resolveResumeCursor({
      startingAfter: c.req.query("starting_after"),
      lastEventId: c.req.header("last-event-id"),
    });
    if (!cursor.ok) {
      return c.json(
        { code: "invalid_cursor", message: "starting_after and Last-Event-ID must be a seq." },
        400,
      );
    }

    const team = c.get("team");
    const user = c.get("user");
    const sessionId = c.get("sessionId");
    const run = await loadRun(db, team.id, runId);
    if (!run || !canWatchThread(run, user.id)) return notFound();

    const decision = decideStreamOpen({
      ended: run.ended,
      events_compacted: run.compacted,
      last_seq: run.lastSeq,
      cursor: cursor.after,
    });
    if (decision.kind === "gone") {
      return c.json(
        {
          error: {
            code: "events_compacted",
            message: "This run's events were folded into the thread; load the thread instead.",
          },
        },
        410,
      );
    }
    if (decision.kind === "no_content") return c.body(null, 204);

    const release = hub.acquireSlot(user.id);
    if (!release) {
      return c.json(
        { code: "too_many_streams", message: "Too many open streams. Close a tab and retry." },
        429,
      );
    }

    const source: StreamSource = {
      read: (after) => readPage(db, team.id, runId, after),
      async revalidate() {
        if (!(await sessionIsLive(deps, sessionId))) return false;
        if ((await getMembership(db, team.id, user.id)) === null) return false;
        const current = await loadRun(db, team.id, runId);
        return current !== null && canWatchThread(current, user.id);
      },
    };
    const body = createRunEventStream({
      runId,
      cursor: cursor.after,
      source,
      hub,
      timings,
      onEnd: release,
      abortConnection: nodeResponseDestroyer(c.env),
    });
    return new Response(body, { status: 200, headers: SSE_HEADERS });
  });

  return app;
}
