import { z } from "zod";
import {
  SKILL_BLOCK_REASON_MAX,
  and,
  desc,
  eq,
  inArray,
  skillBlocklist,
  sql,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * The install skill blocklist (KOBE-81, spec D22): SHA-256 hashes of canonical skill bundles that
 * never load anywhere. Every enforcement point reads the table itself (upload, review decision,
 * run start); nothing is cached, so a new entry takes effect on the next request in every team.
 */

/** 64 hex characters in any case; stored lowercase like `content_hash`. */
export const hashSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "a SHA-256 hash is 64 hexadecimal characters")
  .transform((h) => h.toLowerCase());

export const reasonSchema = z.string().trim().min(1).max(SKILL_BLOCK_REASON_MAX);

export interface BlockedEntry {
  readonly contentHash: string;
  readonly reason: string;
  readonly addedBy: string;
  readonly addedAt: Date;
}

/** Which of `hashes` are blocklisted (a tiny indexed read; call it inside the enforcing transaction). */
export async function blockedAmong(tx: KobeTx, hashes: readonly string[]): Promise<string[]> {
  if (hashes.length === 0) return [];
  const rows = await tx
    .select({ hash: skillBlocklist.contentHash })
    .from(skillBlocklist)
    .where(inArray(skillBlocklist.contentHash, [...new Set(hashes)]));
  return rows.map((r) => r.hash);
}

export async function isBlocked(tx: KobeTx, hash: string): Promise<boolean> {
  return (await blockedAmong(tx, [hash])).length > 0;
}

const PAGE_MAX = 200;

interface Cursor {
  /** `added_at` as Postgres prints it (microseconds survive). */
  readonly at: string;
  readonly hash: string;
}
const cursorSchema = z.object({ at: z.string().max(40), hash: z.string().length(64) });
const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");

/** Undefined for a malformed cursor (a 400 for the caller). */
export function decodeBlockCursor(value: string): Cursor | undefined {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString()));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export interface BlockPage {
  readonly entries: BlockedEntry[];
  readonly nextCursor: string | null;
}

/** Newest first, keyset-paged on (added_at, hash). */
export async function listBlocked(
  db: KobeDb,
  page: { limit?: number; cursor?: Cursor } = {},
): Promise<BlockPage> {
  const limit = Math.min(page.limit ?? PAGE_MAX, PAGE_MAX);
  const c = page.cursor;
  const after = c
    ? sql`(${skillBlocklist.addedAt} < ${c.at}::timestamptz
        OR (${skillBlocklist.addedAt} = ${c.at}::timestamptz AND ${skillBlocklist.contentHash} > ${c.hash}))`
    : undefined;
  const rows = await db
    .select({
      contentHash: skillBlocklist.contentHash,
      reason: skillBlocklist.reason,
      addedBy: skillBlocklist.addedBy,
      addedAt: skillBlocklist.addedAt,
      at: sql<string>`${skillBlocklist.addedAt}::text`,
    })
    .from(skillBlocklist)
    .where(after)
    .orderBy(desc(skillBlocklist.addedAt), skillBlocklist.contentHash)
    .limit(limit + 1);
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return {
    entries: shown.map(({ at: _at, ...entry }) => entry),
    nextCursor:
      rows.length > limit && last ? encode({ at: last.at, hash: last.contentHash }) : null,
  };
}

/** Adds a hash; false when it is already listed. Audited (hash only) in the same transaction. */
export function addBlocked(
  db: KobeDb,
  entry: { hash: string; reason: string; userId: string },
): Promise<BlockedEntry | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(skillBlocklist)
      .values({ contentHash: entry.hash, reason: entry.reason, addedBy: entry.userId })
      .onConflictDoNothing()
      .returning();
    if (!row) return null;
    await recordAudit(tx, { action: "skill.blocklist.added", target: { bundleHash: entry.hash } });
    return row;
  });
}

/** Removes a hash; false when it was not listed. Audited in the same transaction. */
export function removeBlocked(db: KobeDb, hash: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .delete(skillBlocklist)
      .where(and(eq(skillBlocklist.contentHash, hash)))
      .returning({ hash: skillBlocklist.contentHash });
    if (rows.length === 0) return false;
    await recordAudit(tx, { action: "skill.blocklist.removed", target: { bundleHash: hash } });
    return true;
  });
}
