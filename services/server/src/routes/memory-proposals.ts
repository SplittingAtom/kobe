import { Hono } from "hono";
import type { TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  approveProposal,
  approveSchema,
  reasonSchema,
  turnDownProposal,
} from "../memory/proposals/decide.js";
import { listMine, listQueue } from "../memory/proposals/list.js";
import { repropose } from "../memory/proposals/propose.js";
import { uuidSchema } from "../threads/schemas.js";
import { issueText, memoryRouteKit, refuseAgentWrites } from "./memory-items.js";
import { invalidRequest } from "../http/request.js";

/**
 * Workspace proposals (`/v1/memory/proposals`, KOBE-397, SM22) in the active Workspace. A member
 * proposes from To review (`POST /v1/memory/review/candidates/:id/propose`); curators decide here.
 * Every decision is re-checked on the server (memory/proposals/decide.ts). Agents never decide.
 *
 * - `GET  /` the curators' queue (pending, oldest first; curators only)
 * - `GET  /mine` the caller's own proposals with their outcomes
 * - `POST /:id/approve` `{statement?, kind?, overrides?}` (Edit and approve with the fields)
 * - `POST /:id/request-changes` `{reason}`: back to the proposer's To review
 * - `POST /:id/dismiss` `{reason}`
 * - `POST /:id/repropose`: the caller's expired proposal, sent again with a new clock
 */
export function memoryProposalRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use("*", refuseAgentWrites);
  const { answer, readBody } = memoryRouteKit(deps);
  const proposalId = (raw: string | undefined) => uuidSchema.safeParse(raw);

  app.get("/", (c) => answer(c, "team", (who) => listQueue(db, who)));
  app.get("/mine", (c) => answer(c, "user", (who) => listMine(db, who)));

  app.post("/:id/approve", async (c) => {
    const id = proposalId(c.req.param("id"));
    if (!id.success) return invalidRequest(c, "id must be a proposal id.");
    const body = await readBody(c, approveSchema, true);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "team", (who) => approveProposal(db, who, id.data, body.data));
  });

  for (const [path, outcome] of [
    ["request-changes", "changes_requested"],
    ["dismiss", "dismissed"],
  ] as const) {
    app.post(`/:id/${path}`, async (c) => {
      const id = proposalId(c.req.param("id"));
      if (!id.success) return invalidRequest(c, "id must be a proposal id.");
      const body = await readBody(c, reasonSchema);
      if (!body.success) return invalidRequest(c, issueText(body.error));
      return answer(c, "team", (who) =>
        turnDownProposal(db, who, id.data, outcome, body.data.reason),
      );
    });
  }

  app.post("/:id/repropose", async (c) => {
    const id = proposalId(c.req.param("id"));
    if (!id.success) return invalidRequest(c, "id must be a proposal id.");
    return answer(c, "user", (who) => repropose(db, who, id.data), 201);
  });

  return app;
}
