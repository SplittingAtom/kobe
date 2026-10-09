import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import { driftNoticesFor } from "../connectors/drift-recipients.js";
import type { ServerDeps } from "../deps.js";

/**
 * In-app notice of connector tool drift (KOBE-103): the connectors whose changed or new tools are
 * disabled until an install admin re-approves them, for the people who would be told by email
 * (install admins; admins of teams that enabled the connector). Derived from the connector's current
 * state, so it disappears on re-approval; tool names only.
 */
export function meConnectorNoticesRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.get("/", async (c) =>
    c.json({
      notices: await driftNoticesFor(deps.database.db, {
        id: c.get("user").id,
        installRole: c.get("installRole"),
      }),
    }),
  );
  return app;
}
