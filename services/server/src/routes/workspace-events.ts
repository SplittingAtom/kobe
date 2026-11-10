import type { Hono } from "hono";
import { getMembership, sql, withTeam } from "@kobe/db";
import { WORKSPACE_SYNC_WAIT_MS, workspaceEventsQuerySchema } from "@kobe/protocol";
import { teamRoleAllows } from "../authz/permissions.js";
import type { TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { hitRateLimit } from "../rate-limit.js";
import type { SandboxWaker } from "../sandbox-wire/types.js";
import { createWorkspaceEventStream } from "../workspace-files/event-stream.js";
import { readWorkspaceVersions } from "../workspace-files/events.js";
import { nodeResponseDestroyer, SSE_HEADERS } from "./workspace-changes.js";

/** Refreshes (sync now) per member per minute: each may hold a sandbox push. */
export const SYNC_RATE_LIMIT = { windowMs: 60_000, max: 30 };

export interface WorkspaceEventsOptions {
  readonly waker: SandboxWaker;
  /** How long Refresh waits for the sandbox's push (default {@link WORKSPACE_SYNC_WAIT_MS}). */
  readonly syncWaitMs?: number;
}

/**
 * The Files panel keeping itself current (KOBE-599, contract `@kobe/protocol` workspace-events.ts).
 * Mounted inside the workspace file routes, so `requireTeam` and `team.chat` already ran; the
 * owner is always the session's (team, user).
 *
 * - `POST /sync`: Refresh = sync now. A running sandbox is asked over its wire to push
 *   (`workspace.sync_now`) and the answer waits for that push, bounded; an asleep one is started
 *   (as opening the panel does) and the answer is `asleep` at once. Always 200 with the status.
 * - `GET /events?team=`: SSE of the caller's workspace versions (`workspace.state`, then
 *   `workspace.changed`), woken by the per-user workspace hint (LISTEN/NOTIFY, no Redis).
 */
export function registerWorkspaceEvents(
  app: Hono<{ Variables: TeamVariables }>,
  deps: ServerDeps,
  options: WorkspaceEventsOptions,
) {
  const db = deps.database.db;
  const waitMs = options.syncWaitMs ?? WORKSPACE_SYNC_WAIT_MS;

  app.post("/sync", async (c) => {
    const owner = { teamId: c.get("team").id, userId: c.get("user").id };
    if (!(await hitRateLimit(db, `workspace-sync:${owner.userId}`, SYNC_RATE_LIMIT))) {
      return c.json(
        { code: "rate_limited", message: "Too many refreshes. Wait a moment and try again." },
        429,
      );
    }
    const status = await deps.sandboxWire.syncWorkspace(owner, waitMs);
    if (status === "asleep") {
      void options.waker.wake(owner).catch((err: unknown) => {
        logger.warn({ err, teamId: owner.teamId }, "workspace refresh wake failed");
      });
    }
    return c.json({ status }, 200);
  });

  app.get("/events", async (c) => {
    const params = new URL(c.req.url).searchParams;
    const query = workspaceEventsQuerySchema.safeParse(Object.fromEntries(params));
    if (!query.success) {
      return c.json({ code: "invalid_request", message: "That is not a valid request." }, 400);
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
    const release = hub.acquireWorkspaceSlot(owner.userId);
    if (!release) {
      return c.json(
        { code: "too_many_streams", message: "Too many pages follow file changes. Close a tab." },
        429,
      );
    }
    const sessionId = c.get("sessionId");
    const body = createWorkspaceEventStream({
      userId: owner.userId,
      hub,
      timings,
      onEnd: release,
      abortConnection: nodeResponseDestroyer(c.env),
      read: () => withTeam(db, owner.teamId, (tx) => readWorkspaceVersions(tx, owner)),
      async revalidate() {
        const live = await db.execute<{ live: boolean }>(
          sql`SELECT EXISTS (SELECT 1 FROM sessions WHERE id = ${sessionId}
                              AND expires_at > now()) AS live`,
        );
        if (live.rows[0]?.live !== true) return false;
        return teamRoleAllows(await getMembership(db, owner.teamId, owner.userId), "team.chat");
      },
    });
    return new Response(body, { status: 200, headers: SSE_HEADERS });
  });
}
