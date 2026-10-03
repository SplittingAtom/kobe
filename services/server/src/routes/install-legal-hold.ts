import type { Context } from "hono";
import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import { isSoleInstallAdmin } from "../break-glass/store.js";
import type { ServerDeps } from "../deps.js";
import { idParamSchema, requestHoldSchema, requestReleaseSchema } from "../legal-hold/schemas.js";
import {
  approveHold,
  approveRelease,
  denyHold,
  denyRelease,
  getHold,
  listHolds,
  requestHold,
  requestRelease,
  scopeOf,
  withdrawHold,
  withdrawRelease,
  type HoldDetail,
  type HoldError,
  type HoldResult,
} from "../legal-hold/store.js";
import { invalidRequest, parseBody } from "../teams/http.js";

type Ctx = Context<{ Variables: AuthVariables }>;

const ERRORS = {
  team_not_found: [404, "No team with that id."],
  user_not_found: [404, "No user with that id."],
  subject_is_requester: [400, "You can't place a legal hold on yourself."],
  hold_not_found: [404, "No legal hold with that id."],
  not_pending: [409, "This request has already been decided."],
  not_active: [409, "This legal hold is not in force."],
  self_approval_forbidden: [
    403,
    "A second install admin must approve your request. You can approve your own only when you are the install's only admin.",
  ],
  cannot_deny_own: [403, "Withdraw your own request instead of denying it."],
  not_requester: [403, "Only the admin who asked for the hold can withdraw the request."],
  release_pending: [409, "A release is already waiting for approval."],
  no_release_request: [409, "Nobody has asked to release this hold."],
  release_self_approval_forbidden: [
    403,
    "A second install admin must approve the release you asked for. You can approve it yourself only when you are the install's only admin.",
  ],
  cannot_deny_own_release: [403, "Withdraw your own release request instead of denying it."],
  not_release_requester: [403, "Only the admin who asked for the release can withdraw it."],
} as const satisfies Record<HoldError, readonly [number, string]>;

function fail(c: Ctx, code: HoldError) {
  const [status, message] = ERRORS[code];
  return c.json({ code, message }, status);
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** A hold as install admins see it, with what the viewer may do with it (a courtesy). */
function holdJson(detail: HoldDetail, viewerId: string, soleAdmin: boolean) {
  const { hold } = detail;
  const own = hold.placedBy === viewerId;
  const releasing = hold.status === "active" && hold.releaseRequestedBy !== null;
  const ownRelease = hold.releaseRequestedBy === viewerId;
  return {
    id: hold.id,
    team: detail.team,
    scope: scopeOf(hold),
    subject: detail.subject,
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
 * Legal hold (spec D18; §6.1 `/v1/install/legal-hold`), install admins only. Placing and
 * releasing a hold each need a second install admin (D10's rule). A hold about the viewer is
 * invisible to them.
 */
export function installLegalHoldRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireInstallPermission("install.legal_hold.manage"));

  const respond = async (c: Ctx, result: HoldResult, status: 200 | 201 = 200) => {
    if (!result.ok) return fail(c, result.error);
    const viewer = c.get("user").id;
    const detail = await getHold(db, result.hold.id, viewer);
    if (!detail) return fail(c, "hold_not_found");
    return c.json({ hold: holdJson(detail, viewer, await isSoleInstallAdmin(db, viewer)) }, status);
  };

  app.get("/", async (c) => {
    if (Object.keys(c.req.query()).length > 0)
      return invalidRequest(c, "No filters are supported.");
    const viewer = c.get("user").id;
    const sole = await isSoleInstallAdmin(db, viewer);
    const holds = (await listHolds(db, viewer)).map((d) => holdJson(d, viewer, sole));
    return c.json({ holds, selfApprovalAllowed: sole });
  });

  app.post("/", async (c) => {
    const body = await parseBody(c, requestHoldSchema);
    if (!body) {
      return invalidRequest(
        c,
        "Give the team, optionally one user, and a reason (10-2000 characters).",
      );
    }
    return respond(c, await requestHold(db, c.get("user").id, body), 201);
  });

  app.get("/:id", async (c) => {
    const id = idParamSchema.safeParse(c.req.param("id"));
    if (!id.success) return fail(c, "hold_not_found");
    const viewer = c.get("user").id;
    const detail = await getHold(db, id.data, viewer);
    if (!detail) return fail(c, "hold_not_found");
    return c.json({ hold: holdJson(detail, viewer, await isSoleInstallAdmin(db, viewer)) });
  });

  const decide =
    (action: (db: typeof deps.database.db, by: string, id: string) => Promise<HoldResult>) =>
    async (c: Ctx) => {
      const id = idParamSchema.safeParse(c.req.param("id"));
      if (!id.success) return fail(c, "hold_not_found");
      return respond(c, await action(db, c.get("user").id, id.data));
    };
  app.post("/:id/approve", decide(approveHold));
  app.post("/:id/deny", decide(denyHold));
  app.post("/:id/withdraw", decide(withdrawHold));

  app.post("/:id/release", async (c) => {
    const id = idParamSchema.safeParse(c.req.param("id"));
    if (!id.success) return fail(c, "hold_not_found");
    const body = await parseBody(c, requestReleaseSchema);
    if (!body) return invalidRequest(c, "Give a reason for the release (10-2000 characters).");
    return respond(c, await requestRelease(db, c.get("user").id, id.data, body.reason));
  });
  app.post("/:id/release/approve", decide(approveRelease));
  app.post("/:id/release/deny", decide(denyRelease));
  app.post("/:id/release/withdraw", decide(withdrawRelease));

  return app;
}
