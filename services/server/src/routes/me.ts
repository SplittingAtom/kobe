import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";

export function meRoutes(): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.get("/", (c) => c.json({ user: c.get("user"), siteRole: c.get("siteRole") }));
  return app;
}
