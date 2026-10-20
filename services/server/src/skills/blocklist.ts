import { z } from "zod";
import {
  SKILL_BLOCK_REASON_MAX,
  desc,
  inArray,
  skillBlocklist,
  sql,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { hashGroups } from "./hash-checks.js";

/**
 * The site skill blocklist (KOBE-81, spec D22): SHA-256 hashes of canonical skill bundles that
 * never load anywhere. Every enforcement point reads the table itself (upload, review decision,
 * run start); nothing is cached, so a new entry takes effect on the next request in every team.
 *
 * Entries work on alias groups (KOBE-310, docs/skill-package.md "Identity"): a stored hash whose
 * zip held `evals/` or `kobe.skill.yaml` shares one identity with its runtime hash and every other
 * stored hash aliased to it. A hash is blocked when any member of its group is listed; adding a
 * hash whose group is already blocked changes nothing; removing one unblocks the whole group.
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

/**
 * Which of `hashes` are blocked: listed themselves or through a member of their alias group (two
 * small indexed reads; call it inside the enforcing transaction).
 */
export async function blockedAmong(tx: KobeTx, hashes: readonly string[]): Promise<string[]> {
  if (hashes.length === 0) return [];
  const groups = await hashGroups(tx, hashes);
  const members = [...new Set([...groups.values()].flat())];
  const rows = await tx
    .select({ hash: skillBlocklist.contentHash })
    .from(skillBlocklist)
    .where(inArray(skillBlocklist.contentHash, members));
  const listed = new Set(rows.map((r) => r.hash));
  return [...groups].filter(([, group]) => group.some((h) => listed.has(h))).map(([h]) => h);
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

/**
 * Adds a hash; null when it, or a member of its alias group, is already listed (the group is
 * already blocked). Audited (hash only) in the same transaction.
 */
export function addBlocked(
  db: KobeDb,
  entry: { hash: string; reason: string; userId: string },
): Promise<BlockedEntry | null> {
  return db.transaction((tx) => addBlockedInTx(tx, entry));
}

/** {@link addBlocked} inside the caller's transaction (Reject and block, KOBE-334). */
export async function addBlockedInTx(
  tx: KobeTx,
  entry: { hash: string; reason: string; userId: string },
): Promise<BlockedEntry | null> {
  await lockBlocklist(tx);
  if (await isBlocked(tx, entry.hash)) return null;
  const [row] = await tx
    .insert(skillBlocklist)
    .values({ contentHash: entry.hash, reason: entry.reason, addedBy: entry.userId })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  await recordAudit(tx, { action: "skill.blocklist.added", target: { bundleHash: entry.hash } });
  return row;
}

/**
 * Unblocks `hash` and its whole alias group: every listed member is removed (each audited, hash
 * only, in the same transaction); false when nothing in the group was listed.
 */
export function removeBlocked(db: KobeDb, hash: string): Promise<boolean> {
  return db.transaction((tx) => removeBlockedInTx(tx, hash));
}

/** {@link removeBlocked} inside the caller's transaction (Unrevoke, KOBE-340). */
export function removeBlockedInTx(tx: KobeTx, hash: string): Promise<boolean> {
  return (async () => {
    await lockBlocklist(tx);
    const group = (await hashGroups(tx, [hash])).get(hash) ?? [hash];
    const rows = await tx
      .delete(skillBlocklist)
      .where(inArray(skillBlocklist.contentHash, group))
      .returning({ hash: skillBlocklist.contentHash });
    if (rows.length === 0) return false;
    for (const r of rows.sort((a, b) => a.hash.localeCompare(b.hash)))
      await recordAudit(tx, { action: "skill.blocklist.removed", target: { bundleHash: r.hash } });
    return true;
  })();
}

/** Serializes blocklist writes, so two adds in one alias group can't both see it unblocked. */
const lockBlocklist = (tx: KobeTx) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('kobe.skill_blocklist', 0))`);

/** The listed entry for exactly `hash` (its `added_at` as Postgres prints it), or null. */
export async function blockEntryOf(tx: KobeTx, hash: string): Promise<string | null> {
  const r = await tx.execute<{ at: string }>(sql`
    SELECT added_at::text AS at FROM skill_blocklist WHERE content_hash = ${hash}`);
  return r.rows[0]?.at ?? null;
}

/**
 * Removes one entry, only while it is still the same row (same hash, same `added_at`): an entry
 * removed and added again since (another reason) stays (Unrevoke, KOBE-340 review L2). Audited.
 */
export async function removeBlockEntryInTx(
  tx: KobeTx,
  entry: { readonly hash: string; readonly addedAt: string },
): Promise<boolean> {
  await lockBlocklist(tx);
  const rows = await tx.execute<{ hash: string }>(sql`
    DELETE FROM skill_blocklist
     WHERE content_hash = ${entry.hash} AND added_at = ${entry.addedAt}::timestamptz
    RETURNING content_hash AS hash`);
  if (rows.rows.length === 0) return false;
  await recordAudit(tx, { action: "skill.blocklist.removed", target: { bundleHash: entry.hash } });
  return true;
}
