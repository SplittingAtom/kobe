import { and, asc, desc, eq, gt, gte, like, lt, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { KobeDb } from "../client.js";
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
    // Categories are fixed identifiers (no LIKE wildcards in them).
    query.category === undefined ? undefined : like(auditLog.action, `${query.category}.%`),
    query.actorId === undefined ? undefined : eq(auditLog.actorId, query.actorId),
    query.teamId === undefined ? undefined : eq(auditLog.teamId, query.teamId),
    query.since === undefined ? undefined : gte(auditLog.at, new Date(query.since)),
    query.until === undefined ? undefined : lte(auditLog.at, new Date(query.until)),
  ];
  return where.filter((c): c is SQL => c !== undefined);
}

/**
 * Reads the install-wide audit log (install Owner/Admin, spec D6). Validate untrusted input with
 * `auditQuerySchema` first. Keyset pagination over `seq`: stable under concurrent appends.
 */
export async function listAuditEvents(db: KobeDb, query: AuditQuery): Promise<AuditPage> {
  const limit = query.limit ?? AUDIT_PAGE_DEFAULT;
  const forwards = query.after !== undefined;
  const rows = await db
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
    .where(and(...conditions(query)))
    .orderBy(forwards ? asc(auditLog.seq) : desc(auditLog.seq))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    events: page.map((r) => ({
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
 * Reads one team's audit view (team admins, spec D6): only events recorded with that team's id.
 * `audit_log` is install-wide (no RLS), so this function is the team wall: it always filters on
 * `teamId` and ignores any `teamId` in the query. Client IPs and user agents stay in the install
 * view (personal data of other teams' members and of install admins).
 */
export async function listTeamAuditEvents(
  db: KobeDb,
  teamId: string,
  query: AuditQuery,
): Promise<AuditPage> {
  const team = z.uuid().parse(teamId);
  const page = await listAuditEvents(db, { ...query, teamId: team });
  return {
    ...page,
    events: page.events.map((e) => ({ ...e, ip: null, userAgent: null })),
  };
}
