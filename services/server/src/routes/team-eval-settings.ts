import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { readEvalSettings, setEvalSettings } from "../agents/eval/store.js";
import { invalidRequest, parseBody } from "../teams/http.js";

const bodySchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    maxAttackSuccessRate: z.number().min(0).max(1).optional(),
  })
  .refine((b) => b.enabled !== undefined || b.maxAttackSuccessRate !== undefined);

/**
 * The team's pre-publish eval gate (`/v1/team/eval-settings`, KOBE-93): on or off (off by default)
 * and the attack-success-rate ceiling. Every member can read it (Publish explains itself with it);
 * team admins change it, audited.
 */
export function teamEvalSettingsRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/", requireTeamPermission("team.read"), async (c) =>
    c.json(await readEvalSettings(db, c.get("team").id)),
  );

  app.put("/", requireTeamPermission("team.eval.manage"), async (c) => {
    const body = await parseBody(c, bodySchema);
    if (!body) {
      return invalidRequest(c, "Send enabled and/or maxAttackSuccessRate (a number from 0 to 1).");
    }
    return c.json(await setEvalSettings(db, c.get("team").id, c.get("user").id, body));
  });

  return app;
}
