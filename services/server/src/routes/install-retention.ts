import { Hono } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { notifyAllTeams } from "../retention/notify.js";
import { retentionPeriodSchema } from "../retention/periods.js";
import { cancelMaximumPending, readMaximum, setMaximum } from "../retention/settings.js";

const bodySchema = z.strictObject({ maximum: retentionPeriodSchema });

/**
 * The install's retention maximum (`/v1/install/retention`, spec D6, D8, D18): the longest period
 * any team may keep threads (default forever). Lowering it applies after a 7-day grace period
 * (cancellable; the admins of every team it shortens are emailed), raising it at once; team
 * choices are kept. Audited (`retention.maximum.changed`, `.change_cancelled`).
 */
export function installRetentionRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireInstallPermission("install.retention.manage"));

  app.get("/", async (c) => c.json(await readMaximum(db)));

  app.put("/", async (c) => {
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { code: "invalid_request", message: "Send maximum: 30d, 90d, 1y or forever." },
        400,
      );
    }
    const result = await setMaximum(db, parsed.data.maximum);
    if (result.scheduled) {
      deps.background.run("retention change emails failed", () =>
        notifyAllTeams({ db, mailer: deps.mailer, publicUrl: deps.publicUrl }),
      );
    }
    return c.json(result.view);
  });

  app.delete("/pending", async (c) => {
    const result = await cancelMaximumPending(db);
    if (!result) {
      return c.json(
        { code: "nothing_pending", message: "There is no pending change to cancel." },
        404,
      );
    }
    return c.json(result);
  });

  return app;
}
