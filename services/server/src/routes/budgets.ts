import { Hono } from "hono";
import { z } from "zod";
import { MAX_BUDGET_TOKENS, MAX_BUDGET_USD, MAX_REQUESTS_PER_MINUTE } from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import {
  requireInstallPermission,
  requireTeam,
  requireTeamPermission,
  type TeamVariables,
} from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  getInstallLimits,
  memberBudgetStatus,
  setInstallLimits,
  setMemberBudget,
  setTeamBudget,
  teamBudgetsView,
} from "../budgets/store.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { uuidSchema } from "../threads/schemas.js";

/** Dollars, at most two decimals' worth of meaning (stored to the cent); null = no budget. */
const amount = z
  .number()
  .min(0)
  .max(MAX_BUDGET_USD)
  .transform((v) => Math.round(v * 100) / 100)
  .nullable();
/** Tokens (input + output + cache reads + cache writes); null = no token budget. */
const tokens = z.number().int().min(0).max(MAX_BUDGET_TOKENS).nullable();
const rate = z.number().int().min(1).max(MAX_REQUESTS_PER_MINUTE);
const tokenFields = { monthly_tokens: tokens.optional(), daily_tokens: tokens.optional() };
const nonEmpty = (v: object) => Object.keys(v).length > 0;

const installSchema = z
  .strictObject({
    monthly_usd: amount.optional(),
    daily_usd: amount.optional(),
    ...tokenFields,
    user_requests_per_minute: rate.optional(),
  })
  .refine(nonEmpty, "nothing to change");
const teamSchema = z
  .strictObject({
    monthly_usd: amount.optional(),
    daily_usd: amount.optional(),
    ...tokenFields,
    /** Null: the install's rate. */
    user_requests_per_minute: rate.nullable().optional(),
  })
  .refine(nonEmpty, "nothing to change");
const memberSchema = z
  .strictObject({
    monthly_usd: amount.default(null),
    daily_usd: amount.default(null),
    monthly_tokens: tokens.default(null),
    daily_tokens: tokens.default(null),
  })
  .refine((v) => Object.values(v).some((x) => x !== null), "set at least one budget");

const BUDGET_HINT =
  'Send "monthly_usd"/"daily_usd" (dollars, 0–1,000,000,000) and/or "monthly_tokens"/"daily_tokens" (whole tokens), each a number or null.';

/**
 * Team budgets (`/v1/team/budgets`, spec D8: team admins, `team.budgets.manage`): the team's
 * monthly/daily dollar budget and per-user request rate, and per-member budgets; plus
 * `GET /v1/team/budgets/status` for every member (their own view, the chat's banner).
 */
export function teamBudgetsRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/status", requireTeamPermission("team.read"), async (c) =>
    c.json(await memberBudgetStatus(db, c.get("team").id, c.get("user").id)),
  );

  app.get("/", requireTeamPermission("team.budgets.manage"), async (c) =>
    c.json(await teamBudgetsView(db, c.get("team").id)),
  );

  app.put("/team", requireTeamPermission("team.budgets.manage"), async (c) => {
    const input = await parseBody(c, teamSchema);
    if (!input) {
      return invalidRequest(
        c,
        `${BUDGET_HINT} Optionally "user_requests_per_minute": 1–${MAX_REQUESTS_PER_MINUTE} or null.`,
      );
    }
    const teamId = c.get("team").id;
    await setTeamBudget(db, teamId, input, c.get("user").id);
    void deps.budgets.evaluate(teamId).catch(() => undefined);
    return c.json(await teamBudgetsView(db, teamId));
  });

  app.put("/members/:userId", requireTeamPermission("team.budgets.manage"), async (c) => {
    const userId = uuidSchema.safeParse(c.req.param("userId"));
    const input = await parseBody(c, memberSchema);
    if (!userId.success || !input) return invalidRequest(c, BUDGET_HINT);
    const teamId = c.get("team").id;
    const result = await setMemberBudget(db, teamId, userId.data, input, c.get("user").id);
    if (result !== "ok") {
      return c.json(
        { code: "not_a_member", message: "That user is not a member of this team." },
        404,
      );
    }
    void deps.budgets.evaluate(teamId).catch(() => undefined);
    return c.json(await teamBudgetsView(db, teamId));
  });

  app.delete("/members/:userId", requireTeamPermission("team.budgets.manage"), async (c) => {
    const userId = uuidSchema.safeParse(c.req.param("userId"));
    if (!userId.success) return invalidRequest(c);
    const teamId = c.get("team").id;
    const result = await setMemberBudget(db, teamId, userId.data, null, c.get("user").id);
    if (result !== "ok") {
      return c.json({ code: "budget_not_found", message: "That member has no budget." }, 404);
    }
    return c.json(await teamBudgetsView(db, teamId));
  });

  return app;
}

/**
 * The install budget and default per-user request rate (`/v1/install/budget`, Owner/Admins,
 * `install.budgets.manage`; the Bifrost customer level of D30).
 */
export function installBudgetRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireInstallPermission("install.budgets.manage"));

  app.get("/", async (c) => c.json(await getInstallLimits(db)));

  app.put("/", async (c) => {
    const input = await parseBody(c, installSchema);
    if (!input) {
      return invalidRequest(
        c,
        `${BUDGET_HINT} Optionally "user_requests_per_minute": 1–${MAX_REQUESTS_PER_MINUTE}.`,
      );
    }
    const view = await setInstallLimits(db, input, c.get("user").id);
    // Every team's runs answer to the install budget.
    void deps.budgets.sweep();
    return c.json(view);
  });

  return app;
}
