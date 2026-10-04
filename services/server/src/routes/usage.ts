import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { ActorContext } from "@kobe/protocol";
import type { AuthVariables } from "../auth/session.js";
import {
  requireInstallPermission,
  requireTeam,
  requireTeamPermission,
  type TeamVariables,
} from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  addTotals,
  installUsage,
  runsUsage,
  teamUsage,
  type Bucket,
  type UsageRange,
  type UsageTotals,
} from "../models/usage-store.js";
import { RunError } from "../runs/errors.js";
import { invalidRequest } from "../teams/http.js";
import { uuidSchema } from "../threads/schemas.js";

/** Longest range one request may aggregate. */
export const MAX_RANGE_DAYS = 400;
/** Ranges up to this long are bucketed by hour, longer ones by day (unless `bucket` is given). */
const HOURLY_UP_TO_MS = 3 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_DAYS = 30;

const querySchema = z.strictObject({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  bucket: z.enum(["hour", "day"]).optional(),
});

/** `from`/`to` (ISO, default: the last 30 days) and `bucket` (default by span). */
export function parseUsageRange(
  query: Record<string, string>,
  now = new Date(),
): UsageRange | string {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) {
    return "Use from and to as ISO date-times and bucket as hour or day.";
  }
  const to = parsed.data.to ? new Date(parsed.data.to) : now;
  const from = parsed.data.from
    ? new Date(parsed.data.from)
    : new Date(to.getTime() - DEFAULT_DAYS * DAY_MS);
  const span = to.getTime() - from.getTime();
  if (span <= 0) return "from must be before to.";
  if (span > MAX_RANGE_DAYS * DAY_MS) return `A range is at most ${MAX_RANGE_DAYS} days.`;
  const bucket: Bucket = parsed.data.bucket ?? (span <= HOURLY_UP_TO_MS ? "hour" : "day");
  if (bucket === "hour" && span > 31 * DAY_MS) return "Hourly buckets cover at most 31 days.";
  return { from, to, bucket };
}

function range(c: Context): UsageRange | Response {
  const r = parseUsageRange(c.req.query());
  return typeof r === "string" ? invalidRequest(c, r) : r;
}

/** Team usage dashboard (`/v1/team/usage`): team admins (`team.budgets.manage`, D8). */
export function teamUsageRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.budgets.manage"));
  app.get("/", async (c) => {
    const r = range(c);
    if (r instanceof Response) return r;
    return c.json(await teamUsage(deps.database.db, c.get("team").id, r));
  });
  return app;
}

/** Install usage dashboard (`/v1/install/usage`): Owner/Admins, every team summed. */
export function installUsageRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use(requireInstallPermission("install.usage.read"));
  app.get("/", async (c) => {
    const r = range(c);
    if (r instanceof Response) return r;
    return c.json(await installUsage(deps.database.db, r));
  });
  return app;
}

function actorOf(c: Context<{ Variables: TeamVariables }>): ActorContext {
  const team = c.get("team");
  return {
    user_id: c.get("user").id,
    team_id: team.id,
    install_role: c.get("installRole") ?? "user",
    team_role: team.role,
  };
}

const EMPTY: UsageTotals = {
  calls: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: 0,
  unpriced_calls: 0,
  estimated_calls: 0,
};

async function visible(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RunError) {
      return c.json({ code: err.code, message: err.message }, err.status as 404);
    }
    throw err;
  }
}

/**
 * Usage of one run (`GET /v1/runs/:id/usage`, chat run details) and of a thread
 * (`GET /v1/threads/:id/usage`, per run): whoever may read the run or thread (its owner, project
 * readers). Attribution to a run relies on the sandbox's advisory `x-kobe-run-id` (KOBE-41).
 */
export function runUsageRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  app.get("/:id/usage", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    return visible(c, async () => {
      const actor = actorOf(c);
      await deps.runs.getRun(actor, id.data);
      const [usage] = await runsUsage(deps.database.db, actor.team_id, { runId: id.data });
      return c.json(usage ?? { run_id: id.data, models: [], ...EMPTY });
    });
  });
  return app;
}

export function threadUsageRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  app.get("/:id/usage", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    return visible(c, async () => {
      const actor = actorOf(c);
      // Visibility: the thread's owner or a project reader (throws thread_not_found otherwise).
      await deps.runs.listThreadRuns(actor, id.data);
      const usage = await runsUsage(deps.database.db, actor.team_id, { threadId: id.data });
      return c.json({
        thread_id: id.data,
        totals: usage.reduce<UsageTotals>((acc, u) => addTotals(acc, u), EMPTY),
        runs: usage,
      });
    });
  });
  return app;
}
