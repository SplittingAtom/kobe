import { Hono } from "hono";
import { z } from "zod";
import { installSettings } from "@kobe/db";
import { REQUIRE_TWO_FACTOR, readRequireTwoFactor, type AuthVariables } from "../auth/session.js";
import type { ServerDeps } from "../deps.js";

const settingsSchema = z.object({ requireTwoFactor: z.boolean() }).strict();

/** Install settings (install Owner/Admin only; the full role matrix arrives in KOBE-14). */
export function installSettingsRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use(async (c, next) => {
    if (c.get("installRole") === null) {
      return c.json({ code: "forbidden", message: "Install admins only." }, 403);
    }
    await next();
  });

  app.get("/", async (c) => c.json({ requireTwoFactor: await readRequireTwoFactor(deps) }));

  app.put("/", async (c) => {
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ code: "invalid_request" }, 400);
    const value = String(parsed.data.requireTwoFactor);
    await deps.database.db
      .insert(installSettings)
      .values({ key: REQUIRE_TWO_FACTOR, value })
      .onConflictDoUpdate({ target: installSettings.key, set: { value, updatedAt: new Date() } });
    return c.json({ requireTwoFactor: parsed.data.requireTwoFactor });
  });

  return app;
}
