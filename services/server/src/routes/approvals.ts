import type { Context } from "hono";
import { Hono } from "hono";
import {
  approvalResolutionBodySchema,
  approveAllBodySchema,
  type ActorContext,
} from "@kobe/protocol";
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
    site_role: c.get("siteRole") ?? "user",
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
 * - `GET /v1/approvals/{id}/remember` — what the card may offer for it (KOBE-289): the remember
 *   scopes the team's limits allow with the expiry each would get, the exact-action pattern, and
 *   whether "Approve all waiting" is offered for its run.
 * - `POST /v1/approvals/{id}` `{decision: allow|deny, remember?: {tool_glob, scope, exact?}}` —
 *   decide a pending approval; answers the decided approval.
 * - `POST /v1/approvals/approve-all` `{run_id, approval_ids}` — allow every listed pending
 *   approval of one run, each signed and audited on its own (KOBE-289); answers them.
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

  app.get("/:id/remember", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    return answer(c, async () => c.json(await deps.approvals.rememberOptions(actorOf(c), id.data)));
  });

  app.post("/approve-all", async (c) => {
    const body = await parseBody(c, approveAllBodySchema);
    if (!body) return invalidRequest(c, "Give run_id and 2 to 100 approval_ids of that run.");
    return answer(c, async () =>
      c.json({ approvals: await deps.approvals.approveAll(actorOf(c), body) }),
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
