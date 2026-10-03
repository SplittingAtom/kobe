import type { Context } from "hono";
import { Hono } from "hono";
import { approvalResolutionBodySchema, type ActorContext } from "@kobe/protocol";
import { ApprovalError } from "../approvals/index.js";
import { approvalListQuerySchema } from "../approvals/view.js";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { uuidSchema } from "../threads/schemas.js";

type ApprovalContext = Context<{ Variables: TeamVariables }>;

function actorOf(c: ApprovalContext): ActorContext {
  const team = c.get("team");
  return {
    user_id: c.get("user").id,
    team_id: team.id,
    install_role: c.get("installRole") ?? "user",
    team_role: team.role,
  };
}

async function answer(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApprovalError) {
      return c.json({ code: err.code, message: err.message }, err.status);
    }
    throw err;
  }
}

/**
 * Approvals (spec §6.1 `POST /v1/approvals/{id}`, D29; KOBE-37), team-scoped. Only the run's user
 * sees and decides their approvals; another member's id answers 404.
 *
 * - `GET /v1/approvals?status=&run_id=` — your approvals in the active team, newest first (≤ 100).
 * - `GET /v1/approvals/{id}` — one approval with its full input (the card's details).
 * - `POST /v1/approvals/{id}` `{decision: allow|deny, remember?: {tool_glob, arg_pattern?,
 *   expires_in?}}` — decide a pending approval; answers the decided approval.
 */
export function approvalRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.get("/", async (c) => {
    const query = approvalListQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c, "Filter by status and run_id only.");
    return answer(c, async () =>
      c.json({
        approvals: await deps.approvals.list(actorOf(c), {
          ...(query.data.status === undefined ? {} : { status: query.data.status }),
          ...(query.data.run_id === undefined ? {} : { runId: query.data.run_id }),
        }),
      }),
    );
  });

  app.get("/:id", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    return answer(c, async () => c.json(await deps.approvals.get(actorOf(c), id.data)));
  });

  app.post("/:id", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    const body = await parseBody(c, approvalResolutionBodySchema);
    if (!id.success || !body) {
      return invalidRequest(c, "Give decision (allow or deny) and optionally remember.");
    }
    return answer(c, async () => c.json(await deps.approvals.decide(actorOf(c), id.data, body)));
  });

  return app;
}
