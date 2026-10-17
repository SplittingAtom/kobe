import type { Context, Hono as HonoApp } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  EVAL_CASE_ERROR_HTTP_STATUS,
  evalCaseOptionsSchema,
  reviewEvalCaseBodySchema,
  shareEvalCaseBodySchema,
  type EvalCaseErrorCode,
} from "@kobe/protocol";
import { withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import type { ResolvedAgent } from "../agents/version-routes.js";
import { parseBody } from "../teams/http.js";
import { viewerProjectIds } from "../threads/references.js";
import type { Viewer } from "../threads/repository.js";
import { uuidSchema } from "../threads/schemas.js";
import { getAgentCase, listAgentCases, reviewAgentCase, type AgentKey } from "./review.js";
import { myCases, previewCase, shareCase, withdrawCase } from "./share.js";

type Ctx = Context<{ Variables: TeamVariables }>;

/** Largest body: the options (a few ids) or an expected behaviour of 2000 characters. */
const MAX_BODY = 16 * 1024;

const MESSAGES = {
  invalid_request: "Check what you asked to include and try again.",
  run_not_found: "No answer with that id.",
  case_not_found: "No shared case with that id.",
  agent_not_found: "No agent with that id is available in this team.",
  forbidden: "Only the agent's owner reviews its shared cases.",
  not_shareable:
    "Only a thumbs-down you gave on your own conversation with a team or personal agent can be shared.",
  thread_unavailable: "This conversation can't be shared (it's in Trash or a test).",
  exchange_unavailable: "This answer's prompt isn't recorded yet. Try again in a moment.",
  already_shared: "You already shared this answer. Withdraw it first to share it again.",
  preview_stale: "What would be shared changed since the preview. Look at it again.",
  expected_behaviour_required: "Say what the agent should do before accepting the case.",
  case_limit: "This agent already has the most accepted cases. Dismiss one first.",
} as const satisfies Record<EvalCaseErrorCode, string>;

export function evalCaseError(c: Context, code: EvalCaseErrorCode) {
  return c.json({ code, message: MESSAGES[code] }, EVAL_CASE_ERROR_HTTP_STATUS[code]);
}

const limit = () =>
  bodyLimit({ maxSize: MAX_BODY, onError: (c) => evalCaseError(c, "invalid_request") });

async function asViewer<T>(
  deps: ServerDeps,
  c: Ctx,
  fn: (tx: KobeTx, viewer: Viewer) => Promise<T>,
): Promise<T> {
  const teamId = c.get("team").id;
  const userId = c.get("user").id;
  return withTeam(deps.database.db, teamId, async (tx) =>
    fn(tx, { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) }),
  );
}

/**
 * The member's side (KOBE-276), on `/v1/runs`: `POST /:id/eval-case/preview` shows exactly what
 * would be shared, `POST /:id/eval-case` shares it (with the preview's digest). Members with
 * `team.chat`. Neither is audited: the sharer stays unnamed to the agent's owner and team admins.
 */
export function runEvalCaseRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.post("/:id/eval-case/preview", limit(), async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return evalCaseError(c, "run_not_found");
    const body = await parseBody(c, evalCaseOptionsSchema);
    if (!body) return evalCaseError(c, "invalid_request");
    const result = await asViewer(deps, c, (tx, viewer) => previewCase(tx, viewer, id.data, body));
    return result.ok ? c.json(result.value) : evalCaseError(c, result.error);
  });

  app.post("/:id/eval-case", limit(), async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return evalCaseError(c, "run_not_found");
    const body = await parseBody(c, shareEvalCaseBodySchema);
    if (!body) return evalCaseError(c, "invalid_request");
    const result = await asViewer(deps, c, (tx, viewer) => shareCase(tx, viewer, id.data, body));
    return result.ok ? c.json(result.value, 201) : evalCaseError(c, result.error);
  });

  return app;
}

/**
 * `GET /v1/eval-cases` (the caller's own shares in the active team) and `DELETE
 * /v1/eval-cases/{id}` (withdraw: always 204, own cases only; under a legal hold it answers the
 * same, and the database keeps the copy for the hold).
 */
export function evalCaseRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  app.get("/", async (c) => {
    const cases = await asViewer(deps, c, (tx, viewer) => myCases(tx, viewer));
    return c.json({ cases });
  });
  app.delete("/:id", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (id.success) await asViewer(deps, c, (tx, viewer) => withdrawCase(tx, viewer, id.data));
    return c.body(null, 204);
  });
  return app;
}

/**
 * Who reviews an agent's shared cases: its owner only (KOBE-276 ac-4). A team agent: its
 * builder-owner while they may still edit it (team admins who don't own it can't read them); a
 * personal agent: its owner. Gallery agents take no cases.
 */
export function mayReviewEvalCases(found: ResolvedAgent, userId: string): boolean {
  switch (found.agent.scope) {
    case "team":
      return found.agent.ownerUserId === userId && found.access.edit;
    case "personal":
      return found.agent.ownerUserId === userId && found.access.see;
    case "gallery":
      return false;
  }
}

export interface AgentEvalCaseRouteOptions {
  readonly db: KobeDb;
  /** The agent named by `:id` if the caller may see it; null → 404 (as for version reads). */
  readonly resolve: (c: Context) => Promise<ResolvedAgent | null>;
  readonly teamId: (c: Context) => string;
  readonly userId: (c: Context) => string;
}

/**
 * The owner's side, on the agents router: `GET /:id/eval-cases`, `GET /:id/eval-cases/:caseId`
 * and `PATCH /:id/eval-cases/:caseId` (accept, dismiss, reopen, expected behaviour).
 */
export function mountAgentEvalCases<E extends { Variables: object }>(
  app: HonoApp<E>,
  options: AgentEvalCaseRouteOptions,
): void {
  const owned = async (c: Context): Promise<AgentKey | Response> => {
    const found = await options.resolve(c);
    if (!found) return evalCaseError(c, "agent_not_found");
    if (!mayReviewEvalCases(found, options.userId(c))) return evalCaseError(c, "forbidden");
    const scope = found.agent.scope === "personal" ? "personal" : "team";
    return { teamId: options.teamId(c), agentId: found.agent.id, scope };
  };
  const inTeam = <T>(key: AgentKey, fn: (tx: KobeTx) => Promise<T>) =>
    withTeam(options.db, key.teamId, fn);

  app.get("/:id/eval-cases", async (c) => {
    const key = await owned(c);
    if (key instanceof Response) return key;
    return c.json(await inTeam(key, (tx) => listAgentCases(tx, key)));
  });

  app.get("/:id/eval-cases/:caseId", async (c) => {
    const key = await owned(c);
    if (key instanceof Response) return key;
    const caseId = uuidSchema.safeParse(c.req.param("caseId"));
    if (!caseId.success) return evalCaseError(c, "case_not_found");
    const found = await inTeam(key, (tx) => getAgentCase(tx, key, caseId.data));
    return found ? c.json(found) : evalCaseError(c, "case_not_found");
  });

  app.patch("/:id/eval-cases/:caseId", limit(), async (c) => {
    const key = await owned(c);
    if (key instanceof Response) return key;
    const caseId = uuidSchema.safeParse(c.req.param("caseId"));
    if (!caseId.success) return evalCaseError(c, "case_not_found");
    const body = await parseBody(c, reviewEvalCaseBodySchema);
    if (!body) return evalCaseError(c, "invalid_request");
    const result = await inTeam(key, (tx) =>
      reviewAgentCase(tx, key, caseId.data, body, { userId: options.userId(c) }),
    );
    return result.ok ? c.json(result.value) : evalCaseError(c, result.error);
  });
}
