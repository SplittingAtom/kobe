import type { Context } from "hono";
import { Hono } from "hono";
import {
  SiteBreakGlassDenied,
  readPortableWithSiteBreakGlass,
  type PortableBreakGlassItem,
  type PortableBreakGlassRead,
  type PortableBreakGlassResult,
} from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import { currentAuditContext } from "../audit/context.js";
import { requireSitePermission } from "../authz/middleware.js";
import { activeSiteAdmins } from "../break-glass/store.js";
import type { ServerDeps } from "../deps.js";
import { hitRateLimit } from "../rate-limit.js";
import { deliverSiteBreakGlassNotifications } from "../site-break-glass/outbox.js";
import {
  listSiteGrantsQuerySchema,
  requestSiteGrantSchema,
  siteGrantItemsQuerySchema,
  siteIdParamSchema,
} from "../site-break-glass/schemas.js";
import {
  approveSiteGrant,
  denySiteGrant,
  getSiteGrant,
  listSiteGrants,
  requestSiteGrant,
  revokeSiteGrant,
  siteEffectiveStatus,
  type SiteGrantDetail,
  type SiteGrantError,
  type SiteGrantResult,
} from "../site-break-glass/store.js";
import { invalidRequest, param, parseBody } from "../http/request.js";

type Ctx = Context<{ Variables: AuthVariables }>;

/** Reads per site admin and minute (every read is an audited transaction, fanned out). */
export const SITE_BREAK_GLASS_READ_LIMIT = { windowMs: 60_000, max: 120 } as const;
/** Requests per site admin and hour: each one emails every other site admin. */
export const SITE_BREAK_GLASS_REQUEST_LIMIT = { windowMs: 3_600_000, max: 10 } as const;

const ERRORS = {
  subject_not_found: [404, "No person with that id."],
  subject_is_requester: [400, "You can't be the subject of your own request."],
  grant_not_found: [404, "No break-glass grant with that id."],
  not_pending: [409, "This request has already been decided."],
  not_open: [409, "This grant has already ended."],
  request_lapsed: [409, "This request lapsed: nobody decided within 24 hours. Ask again."],
  self_approval_forbidden: [
    403,
    "A second site admin must approve your request. You can approve your own only when no other site admin (besides the person) exists.",
  ],
  subject_cannot_approve: [403, "The subject of a request can't approve it."],
  subject_cannot_decide: [403, "The subject of a request can't deny or revoke it."],
  cannot_deny_own: [403, "Withdraw your own request instead of denying it."],
  too_many_pending: [
    429,
    "You already have 3 open requests for portable memories. Withdraw one or wait for a decision.",
  ],
  rate_limited: [429, "Too many break-glass reads. Wait a minute and continue."],
  request_rate_limited: [
    429,
    "Too many break-glass requests in the last hour. Each one notifies every site admin.",
  ],
  grant_not_active: [
    403,
    "This grant doesn't give access now: it is pending, ended, or you are no longer a site admin.",
  ],
  item_not_found: [404, "No portable memory with that id for this person."],
} as const satisfies Record<string, readonly [number, string]>;

function fail(c: Ctx, code: keyof typeof ERRORS, extra: Record<string, unknown> = {}) {
  const [status, message] = ERRORS[code];
  return c.json({ code, message, ...extra }, status);
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** A Site grant as site admins see it, with what the viewer may do with it. */
function grantJson(detail: SiteGrantDetail, viewerId: string, admins: readonly string[]) {
  const { grant } = detail;
  const status = siteEffectiveStatus(grant);
  const own = grant.adminId === viewerId;
  const alone = !admins.some((a) => a !== viewerId && a !== grant.subjectUserId);
  return {
    id: grant.id,
    subject: detail.subject,
    requestedBy: detail.requestedBy,
    approvedBy: detail.approvedBy,
    decidedBy: detail.decidedBy,
    reason: grant.reason,
    legalHold: grant.legalHold,
    durationMinutes: grant.durationMinutes,
    status,
    selfApproved: grant.selfApproved,
    requestedAt: grant.requestedAt.toISOString(),
    requestExpiresAt: grant.requestExpiresAt.toISOString(),
    decidedAt: iso(grant.decidedAt),
    startsAt: iso(grant.startsAt),
    expiresAt: iso(grant.expiresAt),
    endedAt: iso(grant.endedAt),
    // Courtesy for the console; every action is decided again by the server and the database.
    actions: {
      approve: status === "pending" && (!own || alone) && grant.subjectUserId !== viewerId,
      deny: status === "pending" && !own && grant.subjectUserId !== viewerId,
      revoke: (status === "pending" || status === "active") && grant.subjectUserId !== viewerId,
      read: status === "active" && own,
    },
  };
}

function itemJson(i: PortableBreakGlassItem) {
  return {
    id: i.id,
    kind: i.kind,
    status: i.status,
    superseded_by: i.supersededBy,
    pinned: i.pinned,
    tags: i.tags,
    current_version: i.currentVersion,
    statement: i.statement,
    created_at: i.createdAt.toISOString(),
    updated_at: i.updatedAt.toISOString(),
  };
}

function readGrantJson(result: PortableBreakGlassResult) {
  const { grant } = result;
  return {
    id: grant.id,
    subject_user_id: grant.subjectUserId,
    expires_at: grant.expiresAt.toISOString(),
    workspaces: grant.workspaces,
  };
}

/**
 * Site-level break-glass for portable memories (KOBE-648, SM28; amends D10), site admins only:
 * request, two-person approval, denial, revocation, and the **only** path by which anyone but the
 * owner reads a person's portable memories: read-only GET routes under an active grant, each read
 * verified and audited (Site log + every Workspace of the person) in the data layer. A person's
 * Workspace memories and Workspace items stay under the Workspace grants (`/v1/site/break-glass`).
 */
export function sitePortableBreakGlassRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireSitePermission("site.break_glass.request"));

  const adminIds = async () => (await activeSiteAdmins(db)).map((a) => a.id);

  const respond = async (c: Ctx, result: SiteGrantResult, status: 200 | 201 = 200) => {
    if (!result.ok) return fail(c, result.error satisfies SiteGrantError);
    const viewer = c.get("user").id;
    void deliverSiteBreakGlassNotifications(deps, { grantId: result.grant.id });
    const detail = await getSiteGrant(db, result.grant.id);
    if (!detail) return fail(c, "grant_not_found");
    return c.json(
      { grant: grantJson(detail, viewer, await adminIds()), notified: result.queued },
      status,
    );
  };

  app.get("/", async (c) => {
    const query = listSiteGrantsQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c, "Filter by status only.");
    const viewer = c.get("user").id;
    const admins = await adminIds();
    const grants = (await listSiteGrants(db, viewer))
      .map((d) => grantJson(d, viewer, admins))
      .filter((g) => query.data.status === undefined || g.status === query.data.status);
    return c.json({ grants, selfApprovalAllowed: !admins.some((a) => a !== viewer) });
  });

  app.post("/", async (c) => {
    const body = await parseBody(c, requestSiteGrantSchema);
    if (!body) {
      return invalidRequest(
        c,
        "Give the person, a reason (10-2000 characters) and a duration of 5-1440 minutes.",
      );
    }
    const viewer = c.get("user").id;
    if (
      !(await hitRateLimit(
        db,
        `site-break-glass-request:${viewer}`,
        SITE_BREAK_GLASS_REQUEST_LIMIT,
      ))
    ) {
      return fail(c, "request_rate_limited");
    }
    return respond(c, await requestSiteGrant(db, viewer, body), 201);
  });

  app.get("/:id", async (c) => {
    const id = param(c, "id", siteIdParamSchema);
    if (!id.success) return fail(c, "grant_not_found");
    const viewer = c.get("user").id;
    const detail = await getSiteGrant(db, id.data, viewer);
    if (!detail) return fail(c, "grant_not_found");
    return c.json({ grant: grantJson(detail, viewer, await adminIds()) });
  });

  const decide = (action: typeof approveSiteGrant) => async (c: Ctx) => {
    const id = param(c, "id", siteIdParamSchema);
    if (!id.success) return fail(c, "grant_not_found");
    return respond(c, await action(db, c.get("user").id, id.data));
  };
  const approver = requireSitePermission("site.break_glass.approve");
  app.post("/:id/approve", approver, decide(approveSiteGrant));
  app.post("/:id/deny", approver, decide(denySiteGrant));
  app.post("/:id/revoke", decide(revokeSiteGrant));

  // ── Reads under an active grant (GET only: break-glass never writes) ──

  const read = async (c: Ctx, request: PortableBreakGlassRead) => {
    const id = param(c, "id", siteIdParamSchema);
    if (!id.success) return { response: fail(c, "grant_not_found") };
    const adminId = c.get("user").id;
    if (
      !(await hitRateLimit(db, `site-break-glass-read:${adminId}`, SITE_BREAK_GLASS_READ_LIMIT))
    ) {
      return { response: fail(c, "rate_limited") };
    }
    const context = currentAuditContext();
    try {
      const result = await readPortableWithSiteBreakGlass(
        db,
        {
          grantId: id.data,
          adminId,
          request: { ip: context?.ip ?? null, userAgent: context?.userAgent ?? null },
        },
        request,
      );
      return { result };
    } catch (err) {
      if (!(err instanceof SiteBreakGlassDenied)) throw err;
      if (err.code === "grant_not_active") {
        return { response: fail(c, "grant_not_active", { status: err.status ?? null }) };
      }
      return {
        response: fail(c, err.code === "not_found" ? "item_not_found" : "grant_not_found"),
      };
    }
  };

  app.get("/:id/items", async (c) => {
    const query = siteGrantItemsQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c, "after must be an item id and limit 1-100.");
    const { result, response } = await read(c, {
      kind: "items",
      afterId: query.data.after ?? null,
      limit: query.data.limit,
    });
    if (!result) return response;
    if (result.kind !== "items") throw new Error("unexpected break-glass result");
    return c.json({
      grant: readGrantJson(result),
      items: result.items.map(itemJson),
      next_after: result.nextAfterId,
    });
  });

  app.get("/:id/items/:itemId", async (c) => {
    const itemId = param(c, "itemId", siteIdParamSchema);
    if (!itemId.success) return fail(c, "item_not_found");
    const { result, response } = await read(c, { kind: "item", itemId: itemId.data });
    if (!result) return response;
    if (result.kind !== "item") throw new Error("unexpected break-glass result");
    return c.json({
      grant: readGrantJson(result),
      item: itemJson(result.item),
      versions: result.versions.map((v) => ({
        version: v.version,
        statement: v.statement,
        actor_kind: v.actorKind,
        created_at: v.createdAt.toISOString(),
      })),
    });
  });

  return app;
}
