import {
  and,
  desc,
  egressDomains,
  egressRequestNotifications,
  egressRequests,
  eq,
  findMatchingPattern,
  gt,
  isNull,
  normalizeHost,
  notifyEgressChanged,
  sql,
  teamEgress,
  teamMembers,
  threads,
  users,
  withTeam,
  type EgressRequestEvent,
  type EgressRequestStatus,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * Request access (spec D28, U12; KOBE-39). A member whose sandbox was blocked from a host asks the
 * team's admins to enable it: there is no user self-allow, only a request. The request names the
 * ceiling pattern that would allow the host; approving enables exactly that pattern (within the
 * install ceiling, like the team console does) and settles every pending request for it; denying
 * settles them too. Admins are told when a request arrives, requesters when it is decided (email
 * outbox, request-notify.ts; in-app: the team console's list and the chat notice). Everything is
 * audited; thread metadata is the thread id only.
 */

/** Pending requests per member (each one emails the team's admins). */
export const MAX_PENDING_PER_USER = 20;
/** New requests per member per hour, pending or not (a deny-and-ask-again loop stays bounded). */
export const MAX_REQUESTS_PER_HOUR = 10;

export interface EgressRequestView {
  readonly id: string;
  readonly domain: string;
  readonly pattern: string;
  readonly status: EgressRequestStatus;
  readonly thread_id: string | null;
  readonly requested_by: { readonly id: string; readonly name: string };
  readonly decided_by: string | null;
  readonly created_at: string;
  readonly decided_at: string | null;
}

export type CreateResult =
  | { readonly kind: "created" | "exists"; readonly request: EgressRequestView }
  | { readonly kind: "invalid_domain" | "not_in_ceiling" | "thread_not_found" }
  | { readonly kind: "already_enabled"; readonly pattern: string }
  | { readonly kind: "too_many" };

type Row = typeof egressRequests.$inferSelect;

function view(row: Row, name: string): EgressRequestView {
  return {
    id: row.id,
    domain: row.domain,
    pattern: row.pattern,
    status: row.status,
    thread_id: row.threadId,
    requested_by: { id: row.requestedBy, name },
    decided_by: row.decidedBy,
    created_at: row.createdAt.toISOString(),
    decided_at: row.decidedAt?.toISOString() ?? null,
  };
}

/** Active team admins of the team (RLS: `tx` must be in the team's context). */
async function activeTeamAdmins(tx: KobeTx, teamId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.role, "team_admin"),
        isNull(users.deactivatedAt),
      ),
    );
  return rows.map((r) => r.id);
}

async function queue(
  tx: KobeTx,
  teamId: string,
  items: readonly { requestId: string; recipientId: string }[],
  event: EgressRequestEvent,
): Promise<number> {
  if (items.length === 0) return 0;
  await tx
    .insert(egressRequestNotifications)
    .values(
      items.map((i) => ({ teamId, requestId: i.requestId, recipientId: i.recipientId, event })),
    );
  return items.length;
}

async function userName(tx: KobeTx, userId: string): Promise<string> {
  const [row] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return row?.name ?? "";
}

export async function createEgressRequest(
  db: KobeDb,
  input: {
    readonly teamId: string;
    readonly userId: string;
    readonly domain: string;
    readonly threadId?: string | undefined;
  },
): Promise<CreateResult> {
  const host = normalizeHost(input.domain);
  if (host === null) return { kind: "invalid_domain" };
  const { teamId, userId } = input;
  return withTeam(db, teamId, async (tx) => {
    const ceiling = await tx
      .select({ domain: egressDomains.domain })
      .from(egressDomains)
      .where(eq(egressDomains.inCeiling, true));
    const pattern = findMatchingPattern(new Set(ceiling.map((c) => c.domain)), host);
    if (pattern === undefined) return { kind: "not_in_ceiling" };
    const [enabled] = await tx
      .select({ domain: teamEgress.domain })
      .from(teamEgress)
      .where(and(eq(teamEgress.teamId, teamId), eq(teamEgress.domain, pattern)));
    if (enabled) return { kind: "already_enabled", pattern };
    if (input.threadId !== undefined) {
      // The requester's own live thread in this team (explicit team_id: break-glass policy).
      const [thread] = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(
          and(
            eq(threads.teamId, teamId),
            eq(threads.id, input.threadId),
            eq(threads.ownerUserId, userId),
            isNull(threads.deletedAt),
          ),
        );
      if (!thread) return { kind: "thread_not_found" };
    }
    const name = await userName(tx, userId);
    const mine = and(eq(egressRequests.teamId, teamId), eq(egressRequests.requestedBy, userId));
    const [existing] = await tx
      .select()
      .from(egressRequests)
      .where(and(mine, eq(egressRequests.pattern, pattern), eq(egressRequests.status, "pending")));
    if (existing) return { kind: "exists", request: view(existing, name) };
    const [counts] = await tx
      .select({
        pending: sql<number>`count(*) FILTER (WHERE ${egressRequests.status} = 'pending')::int`,
        recent: sql<number>`count(*) FILTER (WHERE ${egressRequests.createdAt} > now() - interval '1 hour')::int`,
      })
      .from(egressRequests)
      .where(mine);
    if ((counts?.pending ?? 0) >= MAX_PENDING_PER_USER) return { kind: "too_many" };
    if ((counts?.recent ?? 0) >= MAX_REQUESTS_PER_HOUR) return { kind: "too_many" };
    const [row] = await tx
      .insert(egressRequests)
      .values({ teamId, domain: host, pattern, requestedBy: userId, threadId: input.threadId })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      // A concurrent request for the same pattern won the unique index: return that one.
      const [raced] = await tx
        .select()
        .from(egressRequests)
        .where(
          and(mine, eq(egressRequests.pattern, pattern), eq(egressRequests.status, "pending")),
        );
      if (!raced) throw new Error("egress request vanished after a conflict");
      return { kind: "exists", request: view(raced, name) };
    }
    const admins = (await activeTeamAdmins(tx, teamId)).filter((id) => id !== userId);
    const notified = await queue(
      tx,
      teamId,
      admins.map((recipientId) => ({ requestId: row.id, recipientId })),
      "requested",
    );
    await recordAudit(tx, {
      action: "egress.request.created",
      teamId,
      target: {
        requestId: row.id,
        domain: host,
        pattern,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        notified,
      },
    });
    return { kind: "created", request: view(row, name) };
  });
}

export type DecideResult =
  | {
      readonly kind: "decided";
      readonly request: EgressRequestView;
      readonly settled: number;
      readonly enabled: boolean;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_in_ceiling" }
  | { readonly kind: "already_decided"; readonly request: EgressRequestView };

/**
 * A team admin's decision (the route checks `team.egress.manage`). Approve enables the request's
 * pattern if it is still in the install ceiling (409 otherwise; the request stays pending), and
 * either decision settles every pending request for the pattern, each requester notified.
 */
export async function decideEgressRequest(
  db: KobeDb,
  input: {
    readonly teamId: string;
    readonly requestId: string;
    readonly adminId: string;
    readonly decision: "approve" | "deny";
  },
): Promise<DecideResult> {
  const { teamId, adminId } = input;
  return withTeam(db, teamId, async (tx) => {
    const [request] = await tx
      .select()
      .from(egressRequests)
      .where(and(eq(egressRequests.teamId, teamId), eq(egressRequests.id, input.requestId)))
      .for("update");
    if (!request) return { kind: "not_found" };
    const name = await userName(tx, request.requestedBy);
    if (request.status !== "pending") {
      return { kind: "already_decided", request: view(request, name) };
    }
    let enabled = false;
    if (input.decision === "approve") {
      // FOR SHARE: the ceiling row can't be taken out (or deleted) until this commits.
      const [ceiling] = await tx
        .select({ inCeiling: egressDomains.inCeiling })
        .from(egressDomains)
        .where(eq(egressDomains.domain, request.pattern))
        .for("share");
      if (!ceiling?.inCeiling) return { kind: "not_in_ceiling" };
      const inserted = await tx
        .insert(teamEgress)
        .values({ teamId, domain: request.pattern, enabledBy: adminId })
        .onConflictDoNothing()
        .returning({ domain: teamEgress.domain });
      enabled = inserted.length > 0;
      if (enabled) await notifyEgressChanged(tx, teamId);
    }
    const status = input.decision === "approve" ? "approved" : "denied";
    const settled = await tx
      .update(egressRequests)
      .set({ status, decidedBy: adminId, decidedAt: sql`now()` })
      .where(
        and(
          eq(egressRequests.teamId, teamId),
          eq(egressRequests.pattern, request.pattern),
          eq(egressRequests.status, "pending"),
        ),
      )
      .returning();
    await queue(
      tx,
      teamId,
      settled
        .filter((r) => r.requestedBy !== adminId)
        .map((r) => ({ requestId: r.id, recipientId: r.requestedBy })),
      status,
    );
    if (enabled) {
      await recordAudit(tx, {
        action: "egress.domain.enabled",
        teamId,
        target: { domain: request.pattern },
      });
    }
    await recordAudit(tx, {
      action: "egress.request.decided",
      teamId,
      target: {
        requestId: request.id,
        pattern: request.pattern,
        decision: status,
        requests: settled.length,
        enabled,
      },
    });
    const decided = settled.find((r) => r.id === request.id) ?? request;
    return { kind: "decided", request: view(decided, name), settled: settled.length, enabled };
  });
}

const LIST_LIMIT = 100;

/** The team's requests, newest first (team console). `pending` only by default. */
export async function listTeamEgressRequests(
  db: KobeDb,
  teamId: string,
  options: { readonly status?: EgressRequestStatus | "all" } = {},
): Promise<EgressRequestView[]> {
  const status = options.status ?? "pending";
  return withTeam(db, teamId, async (tx) => {
    const rows = await tx
      .select({ request: egressRequests, name: users.name })
      .from(egressRequests)
      .innerJoin(users, eq(users.id, egressRequests.requestedBy))
      .where(
        status === "all"
          ? eq(egressRequests.teamId, teamId)
          : and(eq(egressRequests.teamId, teamId), eq(egressRequests.status, status)),
      )
      .orderBy(desc(egressRequests.createdAt))
      .limit(LIST_LIMIT);
    return rows.map((r) => view(r.request, r.name));
  });
}

/** The caller's own requests in the team, newest first, optionally for one host (chat notice). */
export async function listMyEgressRequests(
  db: KobeDb,
  teamId: string,
  userId: string,
  options: { readonly domain?: string; readonly sinceDays?: number } = {},
): Promise<EgressRequestView[]> {
  const host = options.domain === undefined ? undefined : normalizeHost(options.domain);
  if (host === null) return [];
  return withTeam(db, teamId, async (tx) => {
    const since = new Date(Date.now() - (options.sinceDays ?? 30) * 86_400_000);
    const rows = await tx
      .select({ request: egressRequests, name: users.name })
      .from(egressRequests)
      .innerJoin(users, eq(users.id, egressRequests.requestedBy))
      .where(
        and(
          eq(egressRequests.teamId, teamId),
          eq(egressRequests.requestedBy, userId),
          gt(egressRequests.createdAt, since),
          host === undefined ? undefined : eq(egressRequests.domain, host),
        ),
      )
      .orderBy(desc(egressRequests.createdAt))
      .limit(LIST_LIMIT);
    return rows.map((r) => view(r.request, r.name));
  });
}
