import {
  and,
  count,
  decideEgress,
  desc,
  egressDomains,
  egressRequestNotifications,
  egressRequests,
  eq,
  findMatchingPattern,
  gt,
  isNull,
  inArray,
  normalizeHost,
  notifyEgressChanged,
  parseDomainPattern,
  patternMatches,
  siteRoles,
  sql,
  teamEgress,
  teamMembers,
  teams,
  threads,
  users,
  withTeam,
  type EgressRequestEvent,
  type EgressRequestScope,
  type EgressRequestStatus,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { EgressBlockedReason } from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import { MAX_CEILING_DOMAINS } from "./schemas.js";

type SQL = ReturnType<typeof sql>;

/**
 * Request access (spec D28, U12; KOBE-39). A member whose sandbox was blocked from a host asks the
 * team's admins to enable it: there is no user self-allow, only a request. The request names the
 * ceiling pattern that would allow the host; approving enables exactly that pattern (within the
 * site ceiling, like the team console does) and settles every pending request for it; denying
 * settles them too. Admins are told when a request arrives, requesters when it is decided (email
 * outbox, request-notify.ts; in-app: the team console's list and the chat notice). Everything is
 * audited; thread metadata is the thread id only.
 *
 * KOBE-602 (EA1-EA4): a host outside the ceiling, or one that resolved to an internal address, can
 * be requested too: the request's `scope` is `site` and the site admins are told. A site admin may
 * approve any request with any pattern covering the host (adding it to the ceiling, optionally as
 * internal, and enabling it for the team); a team admin only a `team` request, within the ceiling.
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
  /** `team`: the team's admins decide; `site`: the site admins (KOBE-602, EA1). */
  readonly scope: EgressRequestScope;
  /** The block was an internal address (`forbidden_address`, EA4). */
  readonly internal: boolean;
  readonly thread_id: string | null;
  readonly requested_by: { readonly id: string; readonly name: string };
  readonly decided_by: string | null;
  readonly created_at: string;
  readonly decided_at: string | null;
}

export type CreateResult =
  | { readonly kind: "created" | "exists"; readonly request: EgressRequestView }
  | { readonly kind: "invalid_domain" | "thread_not_found" }
  | { readonly kind: "already_enabled"; readonly pattern: string }
  | { readonly kind: "too_many" };

type Row = typeof egressRequests.$inferSelect;

/**
 * Transaction-scoped advisory locks. A member's requests serialise on (team, user), so the quota
 * check and the insert are atomic; everything that settles or creates requests for a pattern
 * serialises on (team, pattern), so a decision, a direct enablement and a new request never
 * interleave. Order: user lock, then pattern lock (decisions take only the pattern lock).
 */
async function lockKey(tx: KobeTx, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
const lockUser = (tx: KobeTx, teamId: string, userId: string) =>
  lockKey(tx, `kobe.egress-request.user:${teamId}:${userId}`);
export const lockPattern = (tx: KobeTx, teamId: string, pattern: string) =>
  lockKey(tx, `kobe.egress-request.pattern:${teamId}:${pattern}`);

function view(row: Row, name: string): EgressRequestView {
  return {
    id: row.id,
    domain: row.domain,
    pattern: row.pattern,
    status: row.status,
    scope: row.scope,
    internal: row.internal,
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

/** Active site admins and the Owner (site-scope requests, KOBE-602). */
async function activeSiteAdmins(tx: KobeTx): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(siteRoles)
    .innerJoin(users, eq(users.id, siteRoles.userId))
    .where(and(inArray(siteRoles.role, ["owner", "admin"]), isNull(users.deactivatedAt)));
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

interface Target {
  readonly pattern: string;
  readonly scope: EgressRequestScope;
  readonly internal: boolean;
}

/**
 * What a request for `host` asks for (KOBE-602, EA1, EA4), or that nothing is needed: a host the
 * team can already reach is `already_enabled` (an internal block only when its pattern is already
 * internal too). In the ceiling: the covering pattern, team scope. Outside it: the host, site scope.
 * An internal address: site scope always (only site admins mark a pattern internal).
 */
async function requestTarget(
  tx: KobeTx,
  teamId: string,
  host: string,
  internal: boolean,
): Promise<Target | { readonly enabled: string }> {
  const ceilingRows = await tx
    .select({ domain: egressDomains.domain, internal: egressDomains.internal })
    .from(egressDomains)
    .where(eq(egressDomains.inCeiling, true));
  const ceiling = new Set(ceilingRows.map((c) => c.domain));
  const enabledRows = await tx
    .select({ domain: teamEgress.domain })
    .from(teamEgress)
    .where(eq(teamEgress.teamId, teamId));
  const decision = decideEgress(ceiling, new Set(enabledRows.map((r) => r.domain)), host);
  if (decision.allowed) {
    const internalPattern = ceilingRows.find((c) => c.domain === decision.pattern)?.internal;
    if (!internal || internalPattern === true) return { enabled: decision.pattern };
  }
  const inCeiling = findMatchingPattern(ceiling, host);
  if (internal) return { pattern: inCeiling ?? host, scope: "site", internal: true };
  return inCeiling === undefined
    ? { pattern: host, scope: "site", internal: false }
    : { pattern: inCeiling, scope: "team", internal: false };
}

export async function createEgressRequest(
  db: KobeDb,
  input: {
    readonly teamId: string;
    readonly userId: string;
    readonly domain: string;
    readonly threadId?: string | undefined;
    /** The blocked notice's reason (KOBE-602); `forbidden_address` makes an internal request. */
    readonly reason?: EgressBlockedReason | undefined;
  },
): Promise<CreateResult> {
  const host = normalizeHost(input.domain);
  if (host === null) return { kind: "invalid_domain" };
  const { teamId, userId } = input;
  return withTeam(db, teamId, async (tx) => {
    await lockUser(tx, teamId, userId);
    const first = await requestTarget(tx, teamId, host, input.reason === "forbidden_address");
    if ("enabled" in first) return { kind: "already_enabled", pattern: first.enabled };
    // A decision or enablement for this pattern in flight finishes first (no request is created
    // just after its pattern was settled and left pending forever); then look again.
    await lockPattern(tx, teamId, first.pattern);
    const target = await requestTarget(tx, teamId, host, input.reason === "forbidden_address");
    if ("enabled" in target) return { kind: "already_enabled", pattern: target.enabled };
    if (target.pattern !== first.pattern) await lockPattern(tx, teamId, target.pattern);
    const { pattern, scope } = target;
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
      .values({
        teamId,
        domain: host,
        pattern,
        scope,
        internal: target.internal,
        requestedBy: userId,
        threadId: input.threadId,
      })
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
    // Team scope: the team's admins; site scope: the site admins (EA1), never the requester.
    const deciders =
      scope === "team" ? await activeTeamAdmins(tx, teamId) : await activeSiteAdmins(tx);
    const notified = await queue(
      tx,
      teamId,
      deciders
        .filter((id) => id !== userId)
        .map((recipientId) => ({ requestId: row.id, recipientId })),
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
        scope,
        ...(target.internal ? { internal: true as const } : {}),
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
      /** The pattern decided (approved: the one enabled; denied: the request's). */
      readonly pattern: string;
      /** A site admin's approval added the pattern to the ceiling, or put it back in. */
      readonly ceiling: "added" | "restored" | null;
      /** The pattern is internal (same cluster) after this decision. */
      readonly internal: boolean;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_in_ceiling" }
  | { readonly kind: "already_decided"; readonly request: EgressRequestView }
  /** A team admin on a site-scope request (EA2). */
  | { readonly kind: "site_admin_required" }
  /** Only site admins mark a pattern internal (EA4). */
  | { readonly kind: "internal_not_allowed" }
  | { readonly kind: "pattern_invalid"; readonly reason: string }
  /** The chosen pattern does not cover the requested host (EA3). */
  | { readonly kind: "pattern_not_covering" }
  | { readonly kind: "too_many_domains" };

export interface DecideInput {
  readonly teamId: string;
  readonly requestId: string;
  readonly adminId: string;
  readonly decision: "approve" | "deny";
  /**
   * Checked by the route: `site_admin` holds `site.egress.manage`, `team_admin` holds
   * `team.egress.manage` in the request's team (and not the site permission).
   */
  readonly role: "site_admin" | "team_admin";
  /** Approve only: the pattern to enable (default: the request's). Must cover the host. */
  readonly pattern?: string | undefined;
  /** Approve only, site admins only: mark the pattern internal (true); otherwise left as it is. */
  readonly internal?: boolean | undefined;
}

type ChosenPattern =
  | { readonly ok: true; readonly pattern: string }
  | Extract<DecideResult, { kind: "pattern_invalid" | "pattern_not_covering" }>;

/** EA3: a valid pattern (no public suffix, two labels after `*.`) that covers the host. */
function choosePattern(raw: string, host: string): ChosenPattern {
  const parsed = parseDomainPattern(raw);
  if (!parsed.ok) return { kind: "pattern_invalid", reason: parsed.reason };
  if (!patternMatches(parsed.pattern, host)) return { kind: "pattern_not_covering" };
  return { ok: true, pattern: parsed.pattern };
}

interface CeilingOutcome {
  readonly ceiling: "added" | "restored" | null;
  readonly internal: boolean;
  readonly markedInternal: boolean;
}

/**
 * A site admin's approval puts `pattern` in the ceiling (EA1): inserted, or put back in, and marked
 * internal when asked. Serialised with the ceiling console (table lock, as `addCeilingDomain`), so
 * the cap holds. Audited and NOTIFYd like the console's own changes.
 */
async function upsertCeiling(
  tx: KobeTx,
  pattern: string,
  internal: boolean,
  adminId: string,
): Promise<CeilingOutcome | "too_many_domains"> {
  await tx.execute(sql`LOCK TABLE ${egressDomains} IN SHARE ROW EXCLUSIVE MODE`);
  const [existing] = await tx.select().from(egressDomains).where(eq(egressDomains.domain, pattern));
  let ceiling: CeilingOutcome["ceiling"] = null;
  if (!existing) {
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(egressDomains);
    if (n >= MAX_CEILING_DOMAINS) return "too_many_domains";
    await tx
      .insert(egressDomains)
      .values({ domain: pattern, inCeiling: true, internal, createdBy: adminId });
    await recordAudit(tx, { action: "egress.ceiling.added", target: { domain: pattern } });
    ceiling = "added";
  } else if (!existing.inCeiling) {
    await tx
      .update(egressDomains)
      .set({ inCeiling: true, updatedAt: new Date() })
      .where(eq(egressDomains.domain, pattern));
    await recordAudit(tx, {
      action: "egress.ceiling.changed",
      target: { domain: pattern, inCeiling: true },
    });
    ceiling = "restored";
  }
  const markedInternal = internal && existing?.internal !== true;
  if (markedInternal) {
    if (existing) {
      await tx
        .update(egressDomains)
        .set({ internal: true, updatedAt: new Date() })
        .where(eq(egressDomains.domain, pattern));
    }
    await recordAudit(tx, {
      action: "egress.ceiling.internal_changed",
      target: { domain: pattern, internal: true },
    });
  }
  if (ceiling !== null || markedInternal) await notifyEgressChanged(tx, null);
  return { ceiling, internal: internal || existing?.internal === true, markedInternal };
}

/**
 * A decision on a request: from the team console (team admins) or the blocked card
 * (`/v1/egress/requests/:id/decision`, KOBE-602). The rules (EA2, EA3) hold here whatever the UI
 * shows: a team admin decides only a `team` request, enables only a ceiling pattern and never marks
 * one internal; a site admin decides any request, putting the pattern in the ceiling first. The
 * pattern must cover the requested host. Approving settles every pending request in the team the
 * pattern now allows (an internal one only when the pattern is internal); denying settles every
 * pending request for the request's pattern. Each requester is notified.
 */
export async function decideEgressRequest(db: KobeDb, input: DecideInput): Promise<DecideResult> {
  const { teamId, adminId, role } = input;
  const approve = input.decision === "approve";
  if (role === "team_admin" && input.internal === true) return { kind: "internal_not_allowed" };
  return withTeam(db, teamId, async (tx) => {
    const byId = and(eq(egressRequests.teamId, teamId), eq(egressRequests.id, input.requestId));
    const [peek] = await tx
      .select({
        pattern: egressRequests.pattern,
        domain: egressRequests.domain,
        scope: egressRequests.scope,
      })
      .from(egressRequests)
      .where(byId);
    if (!peek) return { kind: "not_found" };
    if (role === "team_admin" && peek.scope === "site") return { kind: "site_admin_required" };
    let pattern = peek.pattern;
    if (approve && input.pattern !== undefined) {
      const chosen = choosePattern(input.pattern, peek.domain);
      if (!("ok" in chosen)) return chosen;
      pattern = chosen.pattern;
    }
    // Concurrent decisions on one pattern serialise here (no deadlock on its rows): sorted locks.
    for (const p of [...new Set([peek.pattern, pattern])].sort()) await lockPattern(tx, teamId, p);
    const [request] = await tx.select().from(egressRequests).where(byId).for("update");
    if (!request) return { kind: "not_found" };
    const name = await userName(tx, request.requestedBy);
    if (request.status !== "pending") {
      return { kind: "already_decided", request: view(request, name) };
    }
    let enabled = false;
    let ceiling: CeilingOutcome = { ceiling: null, internal: false, markedInternal: false };
    if (approve) {
      if (role === "site_admin") {
        const upserted = await upsertCeiling(tx, pattern, input.internal === true, adminId);
        if (upserted === "too_many_domains") return { kind: "too_many_domains" };
        ceiling = upserted;
      } else {
        // FOR SHARE: the ceiling row can't be taken out (or deleted) until this commits.
        const [row] = await tx
          .select({ inCeiling: egressDomains.inCeiling, internal: egressDomains.internal })
          .from(egressDomains)
          .where(eq(egressDomains.domain, pattern))
          .for("share");
        if (!row?.inCeiling) return { kind: "not_in_ceiling" };
        ceiling = { ceiling: null, internal: row.internal, markedInternal: false };
      }
      const inserted = await tx
        .insert(teamEgress)
        .values({ teamId, domain: pattern, enabledBy: adminId })
        .onConflictDoNothing()
        .returning({ domain: teamEgress.domain });
      enabled = inserted.length > 0;
      if (enabled) await notifyEgressChanged(tx, teamId);
    }
    const settled = approve
      ? await settleCovered(tx, teamId, request.id, pattern, ceiling.internal, adminId)
      : await settlePending(tx, teamId, request.pattern, "denied", adminId);
    if (enabled) {
      await recordAudit(tx, {
        action: "egress.domain.enabled",
        teamId,
        target: { domain: pattern },
      });
    }
    await recordAudit(tx, {
      action: "egress.request.decided",
      teamId,
      target: {
        requestId: request.id,
        pattern,
        ...(pattern === request.pattern ? {} : { requested: request.pattern }),
        decision: approve ? "approved" : "denied",
        requests: settled.length,
        enabled,
        by: role,
        ...(ceiling.markedInternal ? { internal: true as const } : {}),
      },
    });
    const decided = settled.find((r) => r.id === request.id) ?? request;
    return {
      kind: "decided",
      request: view(decided, name),
      settled: settled.length,
      enabled,
      pattern,
      ceiling: ceiling.ceiling,
      internal: ceiling.internal,
    };
  });
}

/**
 * Approves the request and every other pending request in the team that `pattern` now allows: the
 * same pattern, or a host it covers (an internal block only when the pattern is internal). Call
 * with the pattern locks held.
 */
async function settleCovered(
  tx: KobeTx,
  teamId: string,
  requestId: string,
  pattern: string,
  internal: boolean,
  adminId: string,
): Promise<Row[]> {
  const pending = await tx
    .select({
      id: egressRequests.id,
      domain: egressRequests.domain,
      pattern: egressRequests.pattern,
      internal: egressRequests.internal,
    })
    .from(egressRequests)
    .where(and(eq(egressRequests.teamId, teamId), eq(egressRequests.status, "pending")));
  const ids = pending
    .filter(
      (r) =>
        r.id === requestId ||
        ((r.pattern === pattern || patternMatches(pattern, r.domain)) && (!r.internal || internal)),
    )
    .map((r) => r.id);
  return settleWhere(tx, teamId, inArray(egressRequests.id, ids), "approved", adminId);
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

export interface SiteEgressRequestView extends EgressRequestView {
  readonly team: { readonly id: string; readonly name: string };
}

/**
 * Site-scope requests across every team, newest first (Site console › Egress, KOBE-602, EA1).
 * Each team's rows are read under its own RLS. `pending` only by default.
 */
export async function listSiteEgressRequests(
  db: KobeDb,
  options: { readonly status?: EgressRequestStatus | "all" } = {},
): Promise<SiteEgressRequestView[]> {
  const status = options.status ?? "pending";
  const all = await db.select({ id: teams.id, name: teams.name }).from(teams);
  const out: SiteEgressRequestView[] = [];
  for (const team of all) {
    const rows = await withTeam(db, team.id, (tx) =>
      tx
        .select({ request: egressRequests, name: users.name })
        .from(egressRequests)
        .innerJoin(users, eq(users.id, egressRequests.requestedBy))
        .where(
          and(
            eq(egressRequests.teamId, team.id),
            eq(egressRequests.scope, "site"),
            status === "all" ? undefined : eq(egressRequests.status, status),
          ),
        )
        .orderBy(desc(egressRequests.createdAt))
        .limit(LIST_LIMIT),
    );
    for (const r of rows) out.push({ ...view(r.request, r.name), team });
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, LIST_LIMIT);
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

/**
 * Settles every pending request for `pattern` (call with the pattern lock held) and queues the
 * requesters' emails (not the deciding admin's own). Returns the settled rows.
 */
export async function settlePending(
  tx: KobeTx,
  teamId: string,
  pattern: string,
  status: "approved" | "denied",
  adminId: string,
): Promise<Row[]> {
  return settleWhere(tx, teamId, eq(egressRequests.pattern, pattern), status, adminId);
}

async function settleWhere(
  tx: KobeTx,
  teamId: string,
  which: SQL | undefined,
  status: "approved" | "denied",
  adminId: string,
): Promise<Row[]> {
  const settled = await tx
    .update(egressRequests)
    .set({ status, decidedBy: adminId, decidedAt: sql`now()` })
    .where(and(eq(egressRequests.teamId, teamId), eq(egressRequests.status, "pending"), which))
    .returning();
  await queue(
    tx,
    teamId,
    settled
      .filter((r) => r.requestedBy !== adminId)
      .map((r) => ({ requestId: r.id, recipientId: r.requestedBy })),
    status,
  );
  return settled;
}
