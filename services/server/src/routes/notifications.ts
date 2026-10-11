import { Hono, type Context } from "hono";
import { listNotificationsQuerySchema, markNotificationsReadBodySchema } from "@kobe/protocol";
import { requireTeam, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { decodeCursor, listNotifications, markNotificationsRead } from "../notifications/store.js";
import { invalidRequest, parseBody } from "../teams/http.js";

/**
 * Notifications (`/v1/notifications`, spec D32, KOBE-179; contract in KOBE-176): the caller's own
 * scheduled-run notifications in the active team, newest first, and marking them read. Any member
 * may call it; nobody sees or marks anyone else's (RLS for the team, `user_id` for the caller).
 */
export function notificationRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  const viewer = (c: Context<{ Variables: TeamVariables }>) => ({
    teamId: c.var.team.id,
    userId: c.var.user.id,
  });

  app.get("/", async (c) => {
    const query = listNotificationsQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return invalidRequest(c, "Send unread (true|false), limit (1-100) and an optional cursor.");
    }
    const { cursor: raw, ...rest } = query.data;
    const cursor = raw === undefined ? null : decodeCursor(raw);
    if (raw !== undefined && cursor === null) return invalidRequest(c, "Unknown cursor.");
    return c.json(await listNotifications(db, viewer(c), rest, cursor));
  });

  app.post("/read", async (c) => {
    const body = await parseBody(c, markNotificationsReadBodySchema);
    if (!body) return invalidRequest(c, 'Send {"notification_ids": [...]} or {"all": true}.');
    return c.json(await markNotificationsRead(db, viewer(c), body));
  });

  return app;
}
