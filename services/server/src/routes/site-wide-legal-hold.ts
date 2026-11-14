import type { Context } from "hono";
import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  idParamSchema,
  requestReleaseSchema,
  requestSiteHoldSchema,
} from "../legal-hold/schemas.js";
import {
  approveSiteHold,
  approveSiteRelease,
  denySiteHold,
  denySiteRelease,
  getSiteHold,
  listSiteHolds,
  requestSiteHold,
  requestSiteRelease,
  siteHoldSoleAdmin,
  withdrawSiteHold,
  withdrawSiteRelease,
  type SiteHoldDetail,
  type SiteHoldError,
  type SiteHoldResult,
} from "../legal-hold/site-store.js";
import { invalidRequest, parseBody } from "../teams/http.js";

type Ctx = Context<{ Variables: AuthVariables }>;

const ERRORS = {
  hold_not_found: [404, "No Site-wide legal hold with that id."],
  not_pending: [409, "This request has already been decided."],
  not_active: [409, "This legal hold is not in force."],
  self_approval_forbidden: [
    403,
    "A second site admin must approve your request. You can approve your own only when you are the site's only admin.",
  ],
  cannot_deny_own: [403, "Withdraw your own request instead of denying it."],
  not_requester: [403, "Only the admin who asked for the hold can withdraw the request."],
  release_pending: [409, "A release is already waiting for approval."],
  no_release_request: [409, "Nobody has asked to release this hold."],
  release_self_approval_forbidden: [
    403,
    "A second site admin must approve the release you asked for. You can approve it yourself only when you are the site's only admin.",
  ],
  cannot_deny_own_release: [403, "Withdraw your own release request instead of denying it."],
  not_release_requester: [403, "Only the admin who asked for the release can withdraw it."],
} as const satisfies Record<SiteHoldError, readonly [number, string]>;

function fail(c: Ctx, code: SiteHoldError) {
  const [status, message] = ERRORS[code];
  return c.json({ code, message }, status);
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** A Site-wide hold as site admins see it, with what the viewer may do with it (a courtesy). */
function holdJson(detail: SiteHoldDetail, viewerId: string, soleAdmin: boolean) {
  const { hold } = detail;
  const own = hold.placedBy === viewerId;
  const releasing = hold.status === "active" && hold.releaseRequestedBy !== null;
  const ownRelease = hold.releaseRequestedBy === viewerId;
  return {
    id: hold.id,
    reason: hold.reason,
    status: hold.status,
    requestedBy: detail.requestedBy,
    requestedAt: hold.requestedAt.toISOString(),
    approvedBy: detail.approvedBy,
    approvedAt: iso(hold.approvedAt),
    selfApproved: hold.selfApproved,
    closedBy: detail.closedBy,
    closedAt: iso(hold.closedAt),
    release: releasing
      ? {
          requestedBy: detail.releaseRequestedBy,
          requestedAt: iso(hold.releaseRequestedAt),
          reason: hold.releaseReason,
        }
      : null,
    releasedBy: detail.releasedBy,
    releasedAt: iso(hold.releasedAt),
    releaseSelfApproved: hold.releaseSelfApproved,
    actions: {
      approve: hold.status === "pending" && (!own || soleAdmin),
      deny: hold.status === "pending" && !own,
      withdraw: hold.status === "pending" && own,
      requestRelease: hold.status === "active" && !releasing,
      approveRelease: releasing && (!ownRelease || soleAdmin),
      denyRelease: releasing && !ownRelease,
      withdrawRelease: releasing && ownRelease,
    },
  };
}

/**
 * Site-wide legal hold (v1.3 SM28, KOBE-647; `/v1/site/site-legal-hold`), site admins only: holds
 * the Site's own memory (Site items and their versions). Placing and releasing each need a second
 * site admin, as for Workspace holds (`/v1/site/legal-hold`). `active` in the list says whether
 * Site memory is held now.
 */
export function siteWideLegalHoldRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireSitePermission("site.legal_hold.manage"));

  const respond = async (c: Ctx, result: SiteHoldResult, status: 200 | 201 = 200) => {
    if (!result.ok) return fail(c, result.error);
    const viewer = c.get("user").id;
    const detail = await getSiteHold(db, result.hold.id);
    if (!detail) return fail(c, "hold_not_found");
    return c.json({ hold: holdJson(detail, viewer, await siteHoldSoleAdmin(db, viewer)) }, status);
  };

  app.get("/", async (c) => {
    if (Object.keys(c.req.query()).length > 0)
      return invalidRequest(c, "No filters are supported.");
    const viewer = c.get("user").id;
    const sole = await siteHoldSoleAdmin(db, viewer);
    const holds = (await listSiteHolds(db)).map((d) => holdJson(d, viewer, sole));
    return c.json({
      holds,
      active: holds.some((h) => h.status === "active"),
      selfApprovalAllowed: sole,
    });
  });

  app.post("/", async (c) => {
    const body = await parseBody(c, requestSiteHoldSchema);
    if (!body) return invalidRequest(c, "Give a reason (10-2000 characters).");
    return respond(c, await requestSiteHold(db, c.get("user").id, body.reason), 201);
  });

  app.get("/:id", async (c) => {
    const id = idParamSchema.safeParse(c.req.param("id"));
    if (!id.success) return fail(c, "hold_not_found");
    const detail = await getSiteHold(db, id.data);
    if (!detail) return fail(c, "hold_not_found");
    const viewer = c.get("user").id;
    return c.json({ hold: holdJson(detail, viewer, await siteHoldSoleAdmin(db, viewer)) });
  });

  const decide =
    (action: (db: typeof deps.database.db, by: string, id: string) => Promise<SiteHoldResult>) =>
    async (c: Ctx) => {
      const id = idParamSchema.safeParse(c.req.param("id"));
      if (!id.success) return fail(c, "hold_not_found");
      return respond(c, await action(db, c.get("user").id, id.data));
    };
  app.post("/:id/approve", decide(approveSiteHold));
  app.post("/:id/deny", decide(denySiteHold));
  app.post("/:id/withdraw", decide(withdrawSiteHold));

  app.post("/:id/release", async (c) => {
    const id = idParamSchema.safeParse(c.req.param("id"));
    if (!id.success) return fail(c, "hold_not_found");
    const body = await parseBody(c, requestReleaseSchema);
    if (!body) return invalidRequest(c, "Give a reason for the release (10-2000 characters).");
    return respond(c, await requestSiteRelease(db, c.get("user").id, id.data, body.reason));
  });
  app.post("/:id/release/approve", decide(approveSiteRelease));
  app.post("/:id/release/deny", decide(denySiteRelease));
  app.post("/:id/release/withdraw", decide(withdrawSiteRelease));

  return app;
}
