import { Hono } from "hono";
import type { TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  approveSiteProposal,
  mergeSiteProposal,
  rejectSiteProposal,
  requestSiteChanges,
} from "../memory/proposals/site/decide.js";
import {
  getSiteProposal,
  getWorkspaceSiteProposal,
  listSiteQueue,
  listWorkspaceSiteProposals,
  siteItemProvenance,
} from "../memory/proposals/site/list.js";
import { proposeSiteFromCandidate, proposeSiteFromItem } from "../memory/proposals/site/propose.js";
import {
  approveSiteProposalSchema,
  confirmSiteProposalSchema,
  mergeSiteProposalSchema,
  proposeSiteFromCandidateSchema,
  proposeSiteFromItemSchema,
  rejectSiteProposalSchema,
  requestSiteChangesSchema,
  siteProposalListQuerySchema,
} from "../memory/proposals/site/schemas.js";
import {
  confirmSiteProposal,
  endorseSiteProposal,
  withdrawSiteProposal,
} from "../memory/proposals/site/team.js";
import { uuidSchema } from "../threads/schemas.js";
import { issueText, memoryRouteKit, refuseAgentWrites } from "./memory-items.js";
import { invalidRequest, param } from "../http/request.js";

const badId = "id must be a proposal id.";

/**
 * Site proposals, Workspace side (`/v1/memory/site-proposals`, KOBE-403 for KOBE-404), in the
 * active Workspace. Every action is re-checked on the server (memory/proposals/site/); agents
 * never act. Answers use the Workspace view (no Site curator names).
 *
 * - `GET  /` `?state&limit`: curators see the Workspace's proposals (Team admins' confirmation
 *   queue: `state=awaiting_team`), a member their own; with `counts` per state
 * - `GET  /:id`
 * - `POST /candidates/:candidateId` `{justification, statement?, kind?}`: Propose → Site
 * - `POST /` `{item_id, justification, statement?, kind?}`: Propose to Site (curators)
 * - `POST /:id/confirm` `{statement?, kind?, justification?}` (Team admins)
 * - `POST /:id/endorse` (curators other than the proposer)
 * - `POST /:id/withdraw` (the proposer or a Team admin)
 */
export function memorySiteProposalRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use("*", refuseAgentWrites);
  const { answer, readBody } = memoryRouteKit(deps);

  app.get("/", (c) => {
    const q = siteProposalListQuerySchema.omit({ from_team_id: true }).safeParse(c.req.query());
    if (!q.success) return invalidRequest(c, issueText(q.error));
    return answer(c, "team", (who) => listWorkspaceSiteProposals(db, who, q.data));
  });

  app.get("/:id", (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c, badId);
    return answer(c, "team", (who) => getWorkspaceSiteProposal(db, who, id.data));
  });

  app.post("/candidates/:candidateId", async (c) => {
    const id = param(c, "candidateId", uuidSchema);
    if (!id.success) return invalidRequest(c, "candidateId must be a candidate id.");
    const body = await readBody(c, proposeSiteFromCandidateSchema);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "team", (who) => proposeSiteFromCandidate(db, who, id.data, body.data), 201);
  });

  app.post("/", async (c) => {
    const body = await readBody(c, proposeSiteFromItemSchema);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "team", (who) => proposeSiteFromItem(db, who, body.data), 201);
  });

  app.post("/:id/confirm", async (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c, badId);
    const body = await readBody(c, confirmSiteProposalSchema, true);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "team", (who) => confirmSiteProposal(db, who, id.data, body.data));
  });

  for (const [path, fn] of [
    ["endorse", endorseSiteProposal],
    ["withdraw", withdrawSiteProposal],
  ] as const) {
    app.post(`/:id/${path}`, (c) => {
      const id = param(c, "id", uuidSchema);
      if (!id.success) return invalidRequest(c, badId);
      return answer(c, "team", (who) => fn(db, who, id.data));
    });
  }

  return app;
}

/**
 * Site proposals, Site side (`/v1/site/memory/proposals`, KOBE-403 for KOBE-405): Site admins
 * and Site memory stewards; no active Workspace needed. Answers use the Site view (names the
 * source Workspace). Others get 403 on the queue and 404 on a proposal.
 *
 * - `GET  /` `?state (default awaiting_site)&from_team_id&limit`, with `counts` per state
 * - `GET  /:id`: the proposal and what the shared checks find against Site memory and Policy
 * - `POST /:id/approve` `{statement?, kind?, policy?, overrides?}`
 * - `POST /:id/merge` `{item_id, statement?, expected_version?, overrides?}`
 * - `POST /:id/reject` `{reason}`
 * - `POST /:id/request-changes` `{note}` (≤ 500; at most 3 rounds)
 * - `GET  /items/:itemId/provenance`: any signed-in user; Site curators see source Workspaces,
 *   everyone else `{set_by: "site"}`
 */
export function siteMemoryProposalRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use("*", refuseAgentWrites);
  const { answer, readBody } = memoryRouteKit(deps);

  app.get("/", (c) => {
    const q = siteProposalListQuerySchema.safeParse(c.req.query());
    if (!q.success) return invalidRequest(c, issueText(q.error));
    return answer(c, "site", (who) => listSiteQueue(db, who, q.data));
  });

  app.get("/items/:itemId/provenance", (c) => {
    const id = param(c, "itemId", uuidSchema);
    if (!id.success) return invalidRequest(c, "itemId must be a memory id.");
    return answer(c, "site", (who) => siteItemProvenance(db, who, id.data));
  });

  app.get("/:id", (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c, badId);
    return answer(c, "site", (who) => getSiteProposal(db, who, id.data));
  });

  app.post("/:id/approve", async (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c, badId);
    const body = await readBody(c, approveSiteProposalSchema, true);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "site", (who) => approveSiteProposal(db, who, id.data, body.data));
  });

  app.post("/:id/merge", async (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c, badId);
    const body = await readBody(c, mergeSiteProposalSchema);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "site", (who) => mergeSiteProposal(db, who, id.data, body.data));
  });

  app.post("/:id/reject", async (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c, badId);
    const body = await readBody(c, rejectSiteProposalSchema);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "site", (who) => rejectSiteProposal(db, who, id.data, body.data.reason));
  });

  app.post("/:id/request-changes", async (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c, badId);
    const body = await readBody(c, requestSiteChangesSchema);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "site", (who) => requestSiteChanges(db, who, id.data, body.data.note));
  });

  return app;
}
