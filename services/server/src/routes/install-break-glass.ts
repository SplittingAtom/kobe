import type { Context } from "hono";
import { Hono } from "hono";
import {
  BreakGlassDenied,
  readWithBreakGlass,
  type BreakGlassEntry,
  type BreakGlassRead,
  type BreakGlassReadResult,
} from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import { currentAuditContext } from "../audit/context.js";
import { requireInstallPermission } from "../authz/middleware.js";
import { notifyGrant } from "../break-glass/notify.js";
import {
  grantEntriesQuerySchema,
  grantThreadsQuerySchema,
  idParamSchema,
  listGrantsQuerySchema,
  requestGrantSchema,
} from "../break-glass/schemas.js";
import {
  approveGrant,
  denyGrant,
  effectiveStatus,
  getGrant,
  isSoleInstallAdmin,
  listGrants,
  requestGrant,
  revokeGrant,
  scopeOf,
  type GrantDetail,
  type GrantError,
  type GrantResult,
} from "../break-glass/store.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { decodeActivityCursor, encodeActivityCursor } from "../threads/cursor.js";
import { toSummary } from "../threads/repository.js";

type Ctx = Context<{ Variables: AuthVariables }>;

const ERRORS = {
  team_not_found: [404, "No team with that id."],
  subject_not_member: [404, "That user is not a member of this team."],
  subject_is_requester: [400, "You can't be the subject of your own request."],
  grant_not_found: [404, "No break-glass grant with that id."],
  not_pending: [409, "This request has already been decided."],
  not_open: [409, "This grant has already ended."],
  request_lapsed: [409, "This request lapsed: nobody decided within 24 hours. Ask again."],
  self_approval_forbidden: [
    403,
    "A second install admin must approve your request. You can approve your own only when you are the install's only admin.",
  ],
  subject_cannot_approve: [403, "The subject of a request can't approve it."],
  subject_cannot_decide: [403, "The subject of a request can't deny or revoke it."],
  cannot_deny_own: [403, "Withdraw your own request instead of denying it."],
  grant_not_active: [
    403,
    "This grant doesn't give access now: it is pending, ended, or you are no longer an install admin.",
  ],
  thread_not_found: [404, "No thread with that id within this grant's scope."],
  invalid_cursor: [400, "The cursor is not valid. Start from the first page."],
} as const satisfies Record<string, readonly [number, string]>;

function fail(c: Ctx, code: keyof typeof ERRORS, extra: Record<string, unknown> = {}) {
  const [status, message] = ERRORS[code];
  return c.json({ code, message, ...extra }, status);
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** A grant as install admins see it, with what the viewer may do with it. */
function grantJson(detail: GrantDetail, viewerId: string, soleAdmin: boolean) {
  const { grant } = detail;
  const status = effectiveStatus(grant);
  const own = grant.adminId === viewerId;
  return {
    id: grant.id,
    team: detail.team,
    requestedBy: detail.requestedBy,
    approvedBy: detail.approvedBy,
    decidedBy: detail.decidedBy,
    scope: scopeOf(grant),
    subject: detail.subject,
    threadId: grant.threadId,
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
      approve: status === "pending" && (!own || soleAdmin) && grant.userId !== viewerId,
      deny: status === "pending" && !own,
      revoke: status === "pending" || status === "active",
      read: status === "active" && own,
    },
  };
}

function entryJson(e: BreakGlassEntry) {
  return {
    entry_id: e.entryId,
    parent_id: e.parentId,
    seq: e.seq,
    type: e.type,
    payload: e.payload,
    payload_offloaded: e.payloadOffloaded,
    created_at: e.createdAt.toISOString(),
  };
}

/** What the reader sees of the grant it is reading under. */
function readGrantJson(result: BreakGlassReadResult) {
  const { grant } = result;
  return {
    id: grant.id,
    team_id: grant.teamId,
    scope: grant.scope,
    user_id: grant.userId,
    thread_id: grant.threadId,
    expires_at: grant.expiresAt.toISOString(),
  };
}

/**
 * Break-glass (spec D10; §6.1 `/v1/install/break-glass`), install admins only. Requests,
 * two-person approval, denial, revocation, and the **only** read path to team content for install
 * admins: read-only GET routes under an active grant, each read verified and audited in the data
 * layer (`readWithBreakGlass`). Normal team routes never honor a grant.
 */
export function installBreakGlassRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireInstallPermission("install.break_glass.request"));

  const respond = async (
    c: Ctx,
    result: GrantResult,
    event: "approved" | "denied" | "revoked",
    status = 200,
  ) => {
    if (!result.ok) return fail(c, result.error satisfies GrantError);
    const viewer = c.get("user").id;
    const detail = await getGrant(db, result.grant.id);
    if (!detail) return fail(c, "grant_not_found");
    void notifyGrant(deps, detail, event, {
      actorId: viewer,
      ...(event === "revoked" ? { wasActive: result.grant.startsAt !== null } : {}),
    });
    return c.json(
      { grant: grantJson(detail, viewer, await isSoleInstallAdmin(db, viewer)) },
      status as 200,
    );
  };

  app.get("/", async (c) => {
    const query = listGrantsQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c, "Filter by status and teamId only.");
    const viewer = c.get("user").id;
    const sole = await isSoleInstallAdmin(db, viewer);
    const grants = (await listGrants(db, viewer, { teamId: query.data.teamId }))
      .map((d) => grantJson(d, viewer, sole))
      .filter((g) => query.data.status === undefined || g.status === query.data.status);
    return c.json({ grants, selfApprovalAllowed: sole });
  });

  app.post("/", async (c) => {
    const body = await parseBody(c, requestGrantSchema);
    if (!body) {
      return invalidRequest(
        c,
        "Give the team, a reason (10-2000 characters), a duration of 5-1440 minutes, and at most one of userId or threadId.",
      );
    }
    const viewer = c.get("user").id;
    const result = await requestGrant(db, viewer, body);
    if (!result.ok) return fail(c, result.error);
    const detail = await getGrant(db, result.grant.id);
    if (!detail) return fail(c, "grant_not_found");
    void notifyGrant(deps, detail, "requested", { actorId: viewer });
    return c.json({ grant: grantJson(detail, viewer, await isSoleInstallAdmin(db, viewer)) }, 201);
  });

  app.get("/:id", async (c) => {
    const id = idParamSchema.safeParse(c.req.param("id"));
    if (!id.success) return fail(c, "grant_not_found");
    const detail = await getGrant(db, id.data, c.get("user").id);
    if (!detail) return fail(c, "grant_not_found");
    const viewer = c.get("user").id;
    return c.json({ grant: grantJson(detail, viewer, await isSoleInstallAdmin(db, viewer)) });
  });

  const decide =
    (action: typeof approveGrant, event: "approved" | "denied" | "revoked") => async (c: Ctx) => {
      const id = idParamSchema.safeParse(c.req.param("id"));
      if (!id.success) return fail(c, "grant_not_found");
      return respond(c, await action(db, c.get("user").id, id.data), event);
    };
  const approver = requireInstallPermission("install.break_glass.approve");
  app.post("/:id/approve", approver, decide(approveGrant, "approved"));
  app.post("/:id/deny", approver, decide(denyGrant, "denied"));
  app.post("/:id/revoke", decide(revokeGrant, "revoked"));

  // ── Reads under an active grant (GET only: break-glass never writes) ──

  const read = async (c: Ctx, request: BreakGlassRead) => {
    const id = idParamSchema.safeParse(c.req.param("id"));
    if (!id.success) return { response: fail(c, "grant_not_found") };
    const context = currentAuditContext();
    try {
      const result = await readWithBreakGlass(
        db,
        {
          grantId: id.data,
          adminId: c.get("user").id,
          request: { ip: context?.ip ?? null, userAgent: context?.userAgent ?? null },
        },
        request,
      );
      return { result };
    } catch (err) {
      if (!(err instanceof BreakGlassDenied)) throw err;
      if (err.code === "grant_not_active") {
        return { response: fail(c, "grant_not_active", { status: err.status ?? null }) };
      }
      return {
        response: fail(c, err.code === "not_found" ? "thread_not_found" : "grant_not_found"),
      };
    }
  };

  const threadParam = (c: Ctx) => idParamSchema.safeParse(c.req.param("threadId"));

  app.get("/:id/threads", async (c) => {
    const query = grantThreadsQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c, "limit must be 1-100.");
    const cursor = query.data.cursor === undefined ? null : decodeActivityCursor(query.data.cursor);
    if (query.data.cursor !== undefined && cursor === null) return fail(c, "invalid_cursor");
    const { result, response } = await read(c, {
      kind: "threads",
      cursor,
      limit: query.data.limit,
    });
    if (!result) return response;
    if (result.kind !== "threads") throw new Error("unexpected break-glass result");
    return c.json({
      grant: readGrantJson(result),
      threads: result.threads.map(toSummary),
      next_cursor: result.next ? encodeActivityCursor(result.next) : null,
    });
  });

  app.get("/:id/threads/:threadId", async (c) => {
    const threadId = threadParam(c);
    if (!threadId.success) return fail(c, "thread_not_found");
    const { result, response } = await read(c, { kind: "thread", threadId: threadId.data });
    if (!result) return response;
    if (result.kind !== "thread") throw new Error("unexpected break-glass result");
    return c.json({ grant: readGrantJson(result), thread: toSummary(result.thread) });
  });

  app.get("/:id/threads/:threadId/entries", async (c) => {
    const threadId = threadParam(c);
    const query = grantEntriesQuerySchema.safeParse(c.req.query());
    if (!threadId.success) return fail(c, "thread_not_found");
    if (!query.success) return invalidRequest(c, "after must be ≥ 0 and limit 1-200.");
    const { result, response } = await read(c, {
      kind: "entries",
      threadId: threadId.data,
      afterSeq: query.data.after,
      limit: query.data.limit,
    });
    if (!result) return response;
    if (result.kind !== "entries") throw new Error("unexpected break-glass result");
    return c.json({
      grant: readGrantJson(result),
      entries: result.entries.map(entryJson),
      next_after: result.nextAfter,
    });
  });

  return app;
}
