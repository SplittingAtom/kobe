import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { allowedPeriods, retentionPeriodSchema, type RetentionView } from "../retention/periods.js";
import { readRetention, setTeamPeriod } from "../retention/settings.js";
import { invalidRequest, parseBody } from "../teams/http.js";

const bodySchema = z.strictObject({ period: retentionPeriodSchema });

const view = (v: RetentionView) => ({ ...v, allowed: allowedPeriods(v.maximum) });

/**
 * Team retention (`/v1/team/retention`, spec D6, D8, D18). Every member can read the period (it
 * says how long their threads are kept); team admins set it, within the install maximum. Team
 * admins still can't read or delete members' threads: the period applies to everyone's alike.
 */
export function teamRetentionRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/", requireTeamPermission("team.read"), async (c) =>
    c.json(view(await readRetention(db, c.get("team").id))),
  );

  app.put("/", requireTeamPermission("team.retention.manage"), async (c) => {
    const body = await parseBody(c, bodySchema);
    if (!body) return invalidRequest(c, "Send period: 30d, 90d, 1y or forever.");
    const result = await setTeamPeriod(db, c.get("team").id, c.get("user").id, body.period);
    if (!result.ok) {
      return c.json(
        {
          code: "exceeds_maximum",
          message: `The install keeps threads at most ${result.maximum}. Choose a shorter period.`,
          maximum: result.maximum,
        },
        409,
      );
    }
    return c.json(view(result.view));
  });

  return app;
}
