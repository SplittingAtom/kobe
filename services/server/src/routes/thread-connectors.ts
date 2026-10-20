import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, eq, isNull, threads, withTeam } from "@kobe/db";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import {
  PROBLEM_TEXT,
  listChatConnectors,
  setThreadConnector,
  type ChatConnector,
  type ToggleError,
} from "../connectors/thread-connectors.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { uuidSchema } from "../threads/schemas.js";

const toggleBodySchema = z.strictObject({ enabled: z.boolean() });

const ERRORS = {
  thread_not_found: [404, "No thread with that id."],
  connector_not_found: [404, "That connector isn't available to you in this team."],
  connector_not_working: [409, "That connector isn't working right now, so it can't be changed."],
} as const satisfies Record<ToggleError, readonly [number, string]>;

/** The wire shape: fixed words for a problem, never a credential or an upstream detail. */
const body = (c: ChatConnector) => ({
  connector_id: c.id,
  name: c.name,
  enabled: c.enabled,
  problem:
    c.problem === null
      ? null
      : {
          code: c.problem,
          message: PROBLEM_TEXT[c.problem].message,
          fix: PROBLEM_TEXT[c.problem].fix,
        },
});

/**
 * The composer's Connectors (KOBE-451), the member's own view in the active team (`team.chat`):
 *
 * GET /v1/threads/connectors                     → 200 `{connectors}` for a conversation not
 *                                                  started yet (all on)
 * GET /v1/threads/{id}/connectors                → 200 `{connectors}` with this thread's on/off;
 *                                                  404 unless the caller owns the thread
 * PUT /v1/threads/{id}/connectors/{connector_id} `{enabled}` → 200 `{connector}`; 404 for another's
 *                                                  thread or a connector not offered; 409 when
 *                                                  it isn't working
 *
 * Mounted before the thread API, so `/connectors` isn't taken for a thread id.
 */
export function threadConnectorRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  app.use(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  const viewerOf = (c: Context<{ Variables: TeamVariables }>) => ({
    teamId: c.get("team").id,
    userId: c.get("user").id,
  });

  app.get("/connectors", async (c) => {
    const viewer = viewerOf(c);
    const list = await withTeam(db, viewer.teamId, (tx) => listChatConnectors(tx, viewer, null));
    return c.json({ connectors: list.map(body) });
  });

  app.get("/:id/connectors", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    const viewer = viewerOf(c);
    const list = await withTeam(db, viewer.teamId, async (tx) => {
      const [own] = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(
          and(
            eq(threads.teamId, viewer.teamId),
            eq(threads.id, id.data),
            eq(threads.ownerUserId, viewer.userId),
            isNull(threads.deletedAt),
          ),
        );
      return own ? listChatConnectors(tx, viewer, own.id) : null;
    });
    if (list === null) {
      const [status, message] = ERRORS.thread_not_found;
      return c.json({ code: "thread_not_found", message }, status);
    }
    return c.json({ connectors: list.map(body) });
  });

  app.put("/:id/connectors/:connectorId", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    const connectorId = uuidSchema.safeParse(c.req.param("connectorId"));
    const toggle = await parseBody(c, toggleBodySchema);
    if (!id.success || !connectorId.success || !toggle) {
      return invalidRequest(c, "Give enabled: true or false.");
    }
    const viewer = viewerOf(c);
    const result = await withTeam(db, viewer.teamId, (tx) =>
      setThreadConnector(tx, viewer, id.data, connectorId.data, toggle.enabled),
    );
    if (!result.ok) {
      const [status, message] = ERRORS[result.error];
      return c.json({ code: result.error, message }, status);
    }
    return c.json({ connector: body(result.connector) });
  });

  return app;
}
