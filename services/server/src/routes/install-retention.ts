import { Hono } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { retentionPeriodSchema } from "../retention/periods.js";
import { readMaximum, setMaximum } from "../retention/settings.js";

const bodySchema = z.strictObject({ maximum: retentionPeriodSchema });

/**
 * The install's retention maximum (`/v1/install/retention`, spec D6, D8, D18): the longest period
 * any team may keep threads (default forever). Lowering it caps every team from the next nightly
 * pass; team choices are kept. Audited (`retention.maximum.changed`).
 */
export function installRetentionRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireInstallPermission("install.retention.manage"));

  app.get("/", async (c) => c.json({ maximum: await readMaximum(db) }));

  app.put("/", async (c) => {
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { code: "invalid_request", message: "Send maximum: 30d, 90d, 1y or forever." },
        400,
      );
    }
    return c.json({ maximum: await setMaximum(db, parsed.data.maximum) });
  });

  return app;
}
