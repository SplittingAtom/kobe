import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { audit, type AuditRequestContext } from "../audit/write.js";
import type { KobeDb, KobeTx } from "../client.js";
import { breakGlassGrants, type BreakGlassStatus } from "../schema/break-glass.js";
import { threadEntries, threads } from "../schema/threads.js";
import {
  BREAK_GLASS_ACTOR_SETTING,
  BREAK_GLASS_GRANT_SETTING,
  TEAM_ID_SETTING,
} from "../settings.js";

/**
 * Break-glass reads (spec D10, KOBE-16): the only way an install admin reads team content.
 *
 * `readWithBreakGlass()` runs one read in one transaction:
 *   1. locks the grant row (`FOR SHARE`) and verifies, in the same statement, that it is approved,
 *      inside its window, requested by this admin, and that the admin is still an active install
 *      admin. A concurrent revocation waits for the read to finish; a read that starts after the
 *      revocation commits is refused. Nothing is cached: every call re-checks.
 *   2. names the grant and the admin in transaction-local settings (`kobe.break_glass_grant`,
 *      `kobe.break_glass_actor`). The `break_glass_read` SELECT policies on the readable team
 *      tables (BREAK_GLASS_READABLE_TABLES) re-verify the grant in Postgres and expose only its
 *      team and scope; `kobe.team_id` is never set, so no write policy can match;
 *   3. records `governance.break_glass.read` (team scope) as the transaction's only write;
 *   4. switches the transaction to read-only (`transaction_read_only`), so nothing after this
 *      point can write, whatever the query;
 *   5. runs the read, narrowed to the grant's scope by RLS and again by the query itself.
 * Reads are bounded by a statement timeout; one that started inside the window finishes even if
 * the window ends meanwhile (RLS evaluates `now()`, the transaction start).
 * A read that finds nothing in scope throws and rolls back with its audit row: nothing was read.
 *
 * The transaction is never handed to the caller: the read kinds below are the whole surface.
 */

export type BreakGlassScope = "team" | "user" | "thread";

export interface BreakGlassAccess {
  readonly grantId: string;
  /** The signed-in install admin; must be the grant's requester. */
  readonly adminId: string;
  /** Client address and user agent for the audit row. */
  readonly request?: AuditRequestContext;
}

/** Keyset position in the thread list: last_activity_at in epoch microseconds, then id. */
export interface BreakGlassThreadCursor {
  readonly micros: string;
  readonly id: string;
}

export type BreakGlassRead =
  | {
      readonly kind: "threads";
      readonly cursor?: BreakGlassThreadCursor | null;
      readonly limit: number;
    }
  | { readonly kind: "thread"; readonly threadId: string }
  | {
      readonly kind: "entries";
      readonly threadId: string;
      readonly afterSeq: number;
      readonly limit: number;
    };

export const BREAK_GLASS_THREADS_MAX = 100;
export const BREAK_GLASS_ENTRIES_MAX = 200;

export interface BreakGlassGrantView {
  readonly id: string;
  readonly teamId: string;
  readonly scope: BreakGlassScope;
  readonly userId: string | null;
  readonly threadId: string | null;
  readonly legalHold: boolean;
  readonly expiresAt: Date;
}

export interface BreakGlassThread {
  readonly id: string;
  readonly title: string | null;
  readonly status: "idle" | "running" | "interrupted";
  readonly ownerUserId: string;
  readonly projectId: string | null;
  readonly agentScope: (typeof threads.$inferSelect)["agentScope"];
  readonly agentId: string | null;
  readonly agentVersion: number | null;
  readonly sharedToProject: boolean;
  readonly modelAlias: string | null;
  readonly leafEntryId: string | null;
  readonly lastActivityAt: Date;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
  readonly isTest: boolean;
}

export interface BreakGlassEntry {
  readonly entryId: string;
  readonly parentId: string | null;
  readonly seq: number;
  readonly type: string;
  /** `{}` when the body was offloaded to object storage (never whatever stayed inline). */
  readonly payload: Record<string, unknown>;
  readonly payloadOffloaded: boolean;
  readonly createdAt: Date;
}

export type BreakGlassReadResult =
  | {
      readonly kind: "threads";
      readonly grant: BreakGlassGrantView;
      readonly threads: readonly BreakGlassThread[];
      readonly next: BreakGlassThreadCursor | null;
    }
  | {
      readonly kind: "thread";
      readonly grant: BreakGlassGrantView;
      readonly thread: BreakGlassThread;
    }
  | {
      readonly kind: "entries";
      readonly grant: BreakGlassGrantView;
      readonly entries: readonly BreakGlassEntry[];
      readonly nextAfter: number | null;
    };

export type BreakGlassDeniedCode =
  /** No such grant, or another admin's: indistinguishable. */
  | "grant_not_found"
  /** Pending, denied, revoked, expired, or the requester is no longer an install admin. */
  | "grant_not_active"
  /** The thread doesn't exist in the team or is outside the grant's scope. */
  | "not_found";

export class BreakGlassDenied extends Error {
  override readonly name = "BreakGlassDenied";
  constructor(
    readonly code: BreakGlassDeniedCode,
    /** The grant's stored status, for `grant_not_active`. */
    readonly status?: BreakGlassStatus,
  ) {
    super(`break-glass read refused: ${code}`);
  }
}

const uuid = z.uuid();
const readSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("threads"),
    cursor: z.object({ micros: z.string().regex(/^(0|[1-9]\d{0,16})$/), id: uuid }).nullish(),
    limit: z.number().int().min(1).max(BREAK_GLASS_THREADS_MAX),
  }),
  z.object({ kind: z.literal("thread"), threadId: uuid }),
  z.object({
    kind: z.literal("entries"),
    threadId: uuid,
    afterSeq: z.number().int().min(0),
    limit: z.number().int().min(1).max(BREAK_GLASS_ENTRIES_MAX),
  }),
]);

const AUDIT_OBJECT = {
  threads: "thread_list",
  thread: "thread",
  entries: "thread_entries",
} as const;

/** Bounds the whole read: the audit chain lock is held from step 3 until commit. */
const STATEMENT_TIMEOUT = "10s";
const LOCK_TIMEOUT = "5s";

const threadColumns = {
  id: threads.id,
  title: threads.title,
  status: threads.status,
  ownerUserId: threads.ownerUserId,
  projectId: threads.projectId,
  agentScope: threads.agentScope,
  agentId: threads.agentId,
  agentVersion: threads.agentVersion,
  sharedToProject: threads.sharedToProject,
  modelAlias: threads.modelAlias,
  leafEntryId: threads.leafEntryId,
  lastActivityAt: threads.lastActivityAt,
  createdAt: threads.createdAt,
  deletedAt: threads.deletedAt,
  isTest: threads.isTest,
};

function scopeOf(row: { userId: string | null; threadId: string | null }): BreakGlassScope {
  if (row.threadId !== null) return "thread";
  return row.userId !== null ? "user" : "team";
}

/** Threads of the grant's team inside its scope (Trash included: investigations need it). */
function inScope(grant: BreakGlassGrantView): SQL {
  const team = eq(threads.teamId, grant.teamId);
  if (grant.threadId !== null) return and(team, eq(threads.id, grant.threadId)) as SQL;
  if (grant.userId !== null) return and(team, eq(threads.ownerUserId, grant.userId)) as SQL;
  return team;
}

/** Step 1: the active grant for this admin, row-locked against concurrent revocation. */
async function lockActiveGrant(tx: KobeTx, access: BreakGlassAccess): Promise<BreakGlassGrantView> {
  const result = await tx.execute<{
    id: string;
    team_id: string;
    user_id: string | null;
    thread_id: string | null;
    legal_hold: boolean;
    expires_at: string;
  }>(sql`
    SELECT g.id, g.team_id, g.user_id, g.thread_id, g.legal_hold, g.expires_at
    FROM ${breakGlassGrants} g
    JOIN users u ON u.id = g.admin_id AND u.deactivated_at IS NULL
    JOIN install_roles r ON r.user_id = g.admin_id
    WHERE g.id = ${access.grantId} AND g.admin_id = ${access.adminId}
      AND g.status = 'approved' AND g.starts_at <= statement_timestamp()
      AND g.expires_at > statement_timestamp()
    FOR SHARE OF g`);
  const row = result.rows[0];
  if (row) {
    return {
      id: row.id,
      teamId: row.team_id,
      scope: scopeOf({ userId: row.user_id, threadId: row.thread_id }),
      userId: row.user_id,
      threadId: row.thread_id,
      legalHold: row.legal_hold,
      expiresAt: new Date(row.expires_at),
    };
  }
  const [known] = await tx
    .select({ status: breakGlassGrants.status })
    .from(breakGlassGrants)
    .where(
      and(eq(breakGlassGrants.id, access.grantId), eq(breakGlassGrants.adminId, access.adminId)),
    );
  throw known
    ? new BreakGlassDenied("grant_not_active", known.status)
    : new BreakGlassDenied("grant_not_found");
}

async function readThreads(
  tx: KobeTx,
  grant: BreakGlassGrantView,
  read: Extract<BreakGlassRead, { kind: "threads" }>,
): Promise<BreakGlassReadResult> {
  const cursor = read.cursor
    ? sql`(${threads.lastActivityAt}, ${threads.id}) < (timestamptz 'epoch' + ${read.cursor.micros}::bigint * interval '1 microsecond', ${read.cursor.id}::uuid)`
    : undefined;
  const rows = await tx
    .select({
      ...threadColumns,
      position: sql<string>`(extract(epoch from ${threads.lastActivityAt}) * 1000000)::bigint::text`,
    })
    .from(threads)
    .where(and(inScope(grant), cursor))
    .orderBy(desc(threads.lastActivityAt), desc(threads.id))
    .limit(read.limit + 1);
  const page = rows.slice(0, read.limit);
  const last = page.at(-1);
  return {
    kind: "threads",
    grant,
    threads: page.map(({ position: _position, ...thread }) => thread),
    next: rows.length > read.limit && last ? { micros: last.position, id: last.id } : null,
  };
}

async function findThreadInScope(
  tx: KobeTx,
  grant: BreakGlassGrantView,
  threadId: string,
): Promise<BreakGlassThread> {
  const [row] = await tx
    .select(threadColumns)
    .from(threads)
    .where(and(inScope(grant), eq(threads.id, threadId)));
  if (!row) throw new BreakGlassDenied("not_found");
  return row;
}

async function readEntries(
  tx: KobeTx,
  grant: BreakGlassGrantView,
  read: Extract<BreakGlassRead, { kind: "entries" }>,
): Promise<BreakGlassReadResult> {
  await findThreadInScope(tx, grant, read.threadId);
  const rows = await tx
    .select({
      entryId: threadEntries.entryId,
      parentId: threadEntries.parentId,
      seq: threadEntries.seq,
      type: threadEntries.type,
      payload: threadEntries.payload,
      blobRef: threadEntries.blobRef,
      createdAt: threadEntries.createdAt,
    })
    .from(threadEntries)
    .where(
      and(
        eq(threadEntries.teamId, grant.teamId),
        eq(threadEntries.threadId, read.threadId),
        sql`${threadEntries.seq} > ${read.afterSeq}`,
      ),
    )
    .orderBy(asc(threadEntries.seq))
    .limit(read.limit + 1);
  const page = rows.slice(0, read.limit);
  return {
    kind: "entries",
    grant,
    entries: page.map(({ blobRef, payload, ...entry }) => ({
      ...entry,
      payload: blobRef !== null ? {} : payload,
      payloadOffloaded: blobRef !== null,
    })),
    nextAfter: rows.length > read.limit ? (page.at(-1)?.seq ?? null) : null,
  };
}

/**
 * Reads team content under an active break-glass grant (see the module comment). Throws
 * `BreakGlassDenied` when the grant isn't usable by this admin right now or the object is outside
 * its scope, and `AuditBusyError` when the audit row can't be written (nothing is returned then).
 */
export async function readWithBreakGlass(
  db: KobeDb,
  access: BreakGlassAccess,
  read: BreakGlassRead,
): Promise<BreakGlassReadResult> {
  if (!uuid.safeParse(access.grantId).success || !uuid.safeParse(access.adminId).success) {
    throw new BreakGlassDenied("grant_not_found");
  }
  const parsed = readSchema.parse(read) as BreakGlassRead;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true),
                                set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
    const team = await tx.execute<{ team: string | null }>(
      sql`SELECT NULLIF(current_setting(${TEAM_ID_SETTING}, true), '') AS team`,
    );
    if (team.rows[0]?.team) throw new Error("readWithBreakGlass: already inside a team context");
    await tx.execute(sql`SELECT set_config(${BREAK_GLASS_GRANT_SETTING}, ${access.grantId}, true),
                                set_config(${BREAK_GLASS_ACTOR_SETTING}, ${access.adminId}, true)`);

    const grant = await lockActiveGrant(tx, access);
    const threadId = parsed.kind === "threads" ? undefined : parsed.threadId;
    await audit(tx, {
      action: "governance.break_glass.read",
      actor: { kind: "user", id: access.adminId },
      teamId: grant.teamId,
      target: {
        grantId: grant.id,
        object: AUDIT_OBJECT[parsed.kind],
        // Under legal hold the team's audit view must not reveal which thread (or whose) was read.
        ...(threadId && !grant.legalHold ? { threadId } : {}),
      },
      ...(access.request ? { request: access.request } : {}),
    });
    // From here on the transaction can't write (the audit row above is its only write).
    await tx.execute(sql`SET LOCAL transaction_read_only = on`);

    switch (parsed.kind) {
      case "threads":
        return readThreads(tx, grant, parsed);
      case "thread":
        return {
          kind: "thread",
          grant,
          thread: await findThreadInScope(tx, grant, parsed.threadId),
        };
      case "entries":
        return readEntries(tx, grant, parsed);
    }
  });
}
