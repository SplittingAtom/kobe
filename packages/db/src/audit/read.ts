import { and, asc, desc, eq, gt, gte, lt, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { KobeDb, KobeTx } from "../client.js";
import { auditLog, type AuditActorKind } from "../schema/audit.js";
import { users } from "../schema/auth.js";
import { AUDIT_ACTIONS, AUDIT_CATEGORIES, type AuditAction } from "./events.js";

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;

/**
 * Filters and keyset cursor for reading the audit log. Newest first by default (`before` pages
 * backwards); with `after`, oldest first (export-style, pages forwards). Cursors are `seq` values.
 */
export const auditQuerySchema = z
  .strictObject({
    limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).optional(),
    before: z.coerce.number().int().positive().optional(),
    after: z.coerce.number().int().nonnegative().optional(),
    action: z.enum(AUDIT_ACTIONS as [AuditAction, ...AuditAction[]]).optional(),
    category: z.enum(AUDIT_CATEGORIES as [string, ...string[]]).optional(),
    actorId: z.uuid().optional(),
    teamId: z.uuid().optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((q) => q.before === undefined || q.after === undefined, {
    message: "use either before or after",
  });

export type AuditQuery = z.output<typeof auditQuerySchema>;

export interface AuditEntry {
  readonly id: string;
  readonly seq: number;
  readonly at: Date;
  readonly teamId: string | null;
  readonly actor: {
    readonly kind: AuditActorKind;
    readonly id: string | null;
    /** Current name and email of a user actor (users are never deleted), else null. */
    readonly name: string | null;
    readonly email: string | null;
  };
  readonly action: string;
  readonly target: Record<string, unknown>;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly prevHash: string;
  readonly hash: string;
}

export interface AuditPage {
  readonly events: AuditEntry[];
  /** Pass as `before` (or `after` when paging forwards) for the next page; null at the end. */
  readonly nextCursor: number | null;
}

function conditions(query: AuditQuery): SQL[] {
  const where: (SQL | undefined)[] = [
    query.before === undefined ? undefined : lt(auditLog.seq, query.before),
    query.after === undefined ? undefined : gt(auditLog.seq, query.after),
    query.action === undefined ? undefined : eq(auditLog.action, query.action),
    // Stored first segment of the action: uses audit_log_category_seq_idx.
    query.category === undefined ? undefined : eq(auditLog.category, query.category),
    query.actorId === undefined ? undefined : eq(auditLog.actorId, query.actorId),
    query.teamId === undefined ? undefined : eq(auditLog.teamId, query.teamId),
    query.since === undefined ? undefined : gte(auditLog.at, new Date(query.since)),
    query.until === undefined ? undefined : lte(auditLog.at, new Date(query.until)),
  ];
  return where.filter((c): c is SQL => c !== undefined);
}

/** Session-bound team of the current transaction (withTeam), or NULL outside one. */
const ACTIVE_TEAM = sql`NULLIF(current_setting('kobe.team_id', true), '')::uuid`;

async function select(
  executor: KobeDb | KobeTx,
  query: AuditQuery,
  where: SQL[],
): Promise<{ rows: AuditEntry[]; nextCursor: number | null }> {
  const limit = query.limit ?? AUDIT_PAGE_DEFAULT;
  const forwards = query.after !== undefined;
  const rows = await executor
    .select({
      id: auditLog.id,
      seq: auditLog.seq,
      at: auditLog.at,
      teamId: auditLog.teamId,
      actorKind: auditLog.actorKind,
      actorId: auditLog.actorId,
      actorName: users.name,
      actorEmail: users.email,
      action: auditLog.action,
      target: auditLog.target,
      ip: sql<string | null>`host(${auditLog.ip})`,
      userAgent: auditLog.userAgent,
      prevHash: auditLog.prevHash,
      hash: auditLog.hash,
    })
    .from(auditLog)
    .leftJoin(users, and(eq(users.id, auditLog.actorId), eq(auditLog.actorKind, "user")))
    .where(and(...where))
    .orderBy(forwards ? asc(auditLog.seq) : desc(auditLog.seq))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map((r) => ({
      id: r.id,
      seq: r.seq,
      at: r.at,
      teamId: r.teamId,
      actor: { kind: r.actorKind, id: r.actorId, name: r.actorName, email: r.actorEmail },
      action: r.action,
      target: r.target,
      ip: r.ip,
      userAgent: r.userAgent,
      prevHash: r.prevHash,
      hash: r.hash,
    })),
    nextCursor: rows.length > limit && last ? last.seq : null,
  };
}

/**
 * Reads the install-wide audit log (install Owner/Admin, spec D6). Validate untrusted input with
 * `auditQuerySchema` first. Keyset pagination over `seq`: stable under concurrent appends.
 */
export async function listAuditEvents(db: KobeDb, query: AuditQuery): Promise<AuditPage> {
  const { rows, nextCursor } = await select(db, query, conditions(query));
  return { events: rows, nextCursor };
}

/** An event as the team view shows it: no client address, user agent or chain fields. */
export type TeamAuditEntry = Omit<AuditEntry, "ip" | "userAgent" | "prevHash" | "hash">;

export interface TeamAuditPage {
  readonly events: TeamAuditEntry[];
  readonly nextCursor: number | null;
}

/**
 * Reads the team audit view (team admins, spec D6) inside a `withTeam()` transaction. The team is
 * not a parameter: the query matches `team_id` against the transaction's `kobe.team_id`, the same
 * setting team RLS uses, so outside withTeam it returns nothing and a `teamId` in the query is
 * ignored. Client IPs, user agents and hash-chain fields stay in the install view.
 */
export async function listTeamAuditEvents(tx: KobeTx, query: AuditQuery): Promise<TeamAuditPage> {
  const { teamId: _ignored, ...rest } = query;
  const { rows, nextCursor } = await select(tx, rest, [
    sql`${auditLog.teamId} = ${ACTIVE_TEAM}`,
    ...conditions(rest),
  ]);
  return {
    events: rows.map(({ ip: _ip, userAgent: _ua, prevHash: _p, hash: _h, ...event }) => event),
    nextCursor,
  };
}
