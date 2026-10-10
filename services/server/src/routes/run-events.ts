import { Hono } from "hono";
import { z } from "zod";
import { decideStreamOpen, resolveResumeCursor } from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import { teamRoleAllows } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";
import { createRunEventStream, type StreamSource } from "../event-stream/stream.js";
import { withTeam } from "@kobe/db";
import { viewerProjectIds } from "../threads/references.js";
import { canWatchThread } from "../event-stream/visibility.js";

const uuid = z.uuid();

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

/**
 * Kobe Event Stream (spec §6.1 `GET /v1/runs/{id}/events`, §6.2, D16). Scoped to the active team
 * (D9); a run is visible to whoever may read its thread. Unknown runs, other teams' runs and
 * teammates' private runs all answer the same 404, so the endpoint is no existence oracle.
 */
export function runEventsRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));

  app.get("/:runId/events", requireTeamPermission("team.chat"), async (c) => {
    // Read per request, so routes that never stream don't touch the event-stream dependencies.
    const { hub, reader, timings } = deps.eventStream;
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
    const memberOf = () =>
      withTeam(deps.database.db, team.id, (tx) => viewerProjectIds(tx, team.id, user.id));
    const run = await reader.loadRun(team.id, runId);
    if (
      !run ||
      !canWatchThread(run, user.id, run.ownerUserId === user.id ? [] : await memberOf())
    ) {
      return notFound();
    }
    // No honest client holds a seq the run hasn't issued (seq is assigned on commit). Refuse it
    // instead of waiting for it, which also ends EventSource's reconnect loop (non-200 stops it).
    // Ended runs answer 204 below, per the contract.
    if (!run.ended && !run.compacted && cursor.after > run.lastSeq) {
      return c.json(
        { code: "invalid_cursor", message: "The cursor is beyond this run's last event." },
        400,
      );
    }

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
      read: (after) => reader.readPage(team.id, runId, after),
      async revalidate() {
        const access = await reader.access({ teamId: team.id, runId, userId: user.id, sessionId });
        return (
          access.sessionLive &&
          teamRoleAllows(access.role, "team.chat") &&
          access.ownerUserId !== null &&
          canWatchThread(
            {
              ownerUserId: access.ownerUserId,
              projectId: access.projectId,
              sharedToProject: access.sharedToProject,
            },
            user.id,
            access.ownerUserId === user.id ? [] : await memberOf(),
          )
        );
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
