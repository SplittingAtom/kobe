import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import {
  SEMANTIC_MEMORY_NEAR_FULL_RATIO,
  SEMANTIC_MEMORY_PINS_MAX,
  SEMANTIC_MEMORY_POLICY_MAX_BYTES,
  SEMANTIC_MEMORY_POLICY_MAX_ITEMS,
} from "@kobe/protocol";
import { logger } from "../../logger.js";
import { notifyMemory } from "../../notifications/memory.js";
import type { MemorySiteSettings } from "../site-settings.js";
import { MemoryItemError } from "./errors.js";
import type { Location } from "./location.js";

/**
 * Scope limits, pins and the Policy budget (KOBE-378; SM21, SM22, SM23). Every write that can
 * change a count first takes a transaction advisory lock for its scope ({@link lockScope}), so
 * the counts below are exact under concurrency. Limits block at 100% (`memory_scope_full`) and
 * nothing is ever evicted or archived to make room.
 */

export async function lockScope(tx: KobeTx, loc: Location): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kobe.memory-scope:${loc.lockKey}`}, 0))`,
  );
}

/** Active items of the scope (per person for `user`/`portable`). */
export async function activeCount(tx: KobeTx, loc: Location): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM ${loc.items} i WHERE ${loc.where} AND i.status = 'active'`);
  return rows[0]?.n ?? 0;
}

export const scopeLimit = (settings: MemorySiteSettings, loc: Location): number =>
  settings.scope_limits[loc.scope];

/** First count at which curators hear the scope is nearly full (80%). */
export const nearFullAt = (max: number): number => Math.ceil(max * SEMANTIC_MEMORY_NEAR_FULL_RATIO);

/** Refuses `needed` more active items past the limit; returns the count before. */
export async function assertRoom(
  tx: KobeTx,
  loc: Location,
  settings: MemorySiteSettings,
  needed: number,
): Promise<number> {
  const count = await activeCount(tx, loc);
  const max = scopeLimit(settings, loc);
  if (needed > 0 && count + needed > max)
    throw new MemoryItemError(
      "memory_scope_full",
      `This scope holds its maximum of ${max} memories. Archive some first; nothing is removed automatically.`,
      { capacity: { count, max, needed } },
    );
  return count;
}

/** Refuses an 11th pinned active item in the scope (`except`: the item being pinned). */
export async function assertPinRoom(tx: KobeTx, loc: Location, except?: string): Promise<void> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM ${loc.items} i
     WHERE ${loc.where} AND i.status = 'active' AND i.pinned
       ${except ? sql`AND i.id <> ${except}` : sql``}`);
  if ((rows[0]?.n ?? 0) >= SEMANTIC_MEMORY_PINS_MAX)
    throw new MemoryItemError(
      "memory_pin_limit",
      `This scope already has ${SEMANTIC_MEMORY_PINS_MAX} pinned memories. Unpin one first.`,
    );
}

export interface PolicyUsage {
  readonly count: number;
  readonly bytes: number;
}

/** Active Policy items and the UTF-8 bytes of their statements (`except`: items left out). */
export async function policyUsage(
  tx: KobeTx,
  except: readonly string[] = [],
): Promise<PolicyUsage> {
  const skip =
    except.length > 0
      ? sql`AND i.id NOT IN (${sql.join(
          except.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql``;
  const { rows } = await tx.execute<{ n: number; bytes: number }>(sql`
    SELECT count(*)::int AS n, coalesce(sum(octet_length(v.statement)), 0)::int AS bytes
      FROM site_memory_items i
      JOIN site_memory_item_versions v ON v.item_id = i.id AND v.version = i.current_version
     WHERE i.status = 'active' AND i.policy ${skip}`);
  return { count: rows[0]?.n ?? 0, bytes: rows[0]?.bytes ?? 0 };
}

/**
 * Refuses a write that would leave active Policy above 25 items or 2 KiB: `statement` is the
 * item's statement after the write, as active Policy (callers skip non-Policy results); `except`
 * names the item itself and any Policy item the write retires (supersede).
 */
export async function assertPolicyBudget(
  tx: KobeTx,
  except: readonly string[],
  statement: string,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('kobe.memory-policy', 0))`);
  const u = await policyUsage(tx, except);
  const count = u.count + 1;
  const bytes = u.bytes + Buffer.byteLength(statement, "utf8");
  if (count > SEMANTIC_MEMORY_POLICY_MAX_ITEMS || bytes > SEMANTIC_MEMORY_POLICY_MAX_BYTES)
    throw new MemoryItemError(
      "memory_policy_budget_full",
      `Policy holds at most ${SEMANTIC_MEMORY_POLICY_MAX_ITEMS} items and ${SEMANTIC_MEMORY_POLICY_MAX_BYTES} bytes of text.`,
    );
}

/** Site recipients still owed the notice after the in-transaction part (see notifyNearFull). */
export type PendingSiteNotices = readonly string[];

/**
 * When a write takes a shared scope from below 80% of its limit to 80% or more, tells its curators
 * once (SM22, `memory.scope.near_full`; crossing back below and up again tells them again).
 * `team`: Team admins and Workspace stewards, in this transaction. `site`: Site admins and Site
 * stewards; those who are members of this Workspace are told here, the rest in the Workspace they
 * used last, after commit ({@link deliverSiteNotices}). Personal scopes show their usage in the
 * list response only (the notice kind names `team | site`).
 */
export async function notifyNearFull(
  tx: KobeTx,
  loc: Location,
  settings: MemorySiteSettings,
  before: number,
  after: number,
): Promise<PendingSiteNotices> {
  if (loc.scope !== "team" && loc.scope !== "site") return [];
  const at = nearFullAt(scopeLimit(settings, loc));
  if (!(before < at && after >= at)) return [];
  const recipients =
    loc.scope === "team" ? await teamCurators(tx, loc.teamId) : await siteCurators(tx);
  const sent = await notifyMemory(tx, loc.teamId, recipients, {
    kind: "memory.scope.near_full",
    scope: loc.scope,
  });
  if (loc.scope === "team") return [];
  const told = new Set(sent.map((s) => s.userId));
  return recipients.filter((r) => !told.has(r));
}

async function teamCurators(tx: KobeTx, teamId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT user_id AS id FROM team_members WHERE team_id = ${teamId} AND role = 'team_admin'
    UNION SELECT user_id FROM memory_stewards WHERE team_id = ${teamId}`);
  return rows.map((r) => r.id);
}

async function siteCurators(tx: KobeTx): Promise<string[]> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT r.user_id AS id FROM site_roles r JOIN users u ON u.id = r.user_id
     WHERE r.role IN ('owner', 'admin') AND u.deactivated_at IS NULL
    UNION
    SELECT g.user_id FROM site_grants g JOIN users u ON u.id = g.user_id
     WHERE g."grant" = 'memory_steward' AND u.deactivated_at IS NULL`);
  return rows.map((r) => r.id);
}

/**
 * After commit: Site curators who are not members of the Workspace that crossed get the notice in
 * the Workspace they used last (`user_last_teams`), one transaction each. Best effort: the write
 * already happened, so a failure is logged, never raised.
 */
export async function deliverSiteNotices(db: KobeDb, pending: PendingSiteNotices): Promise<void> {
  for (const userId of pending) {
    try {
      const { rows } = await db.execute<{ team_id: string }>(
        sql`SELECT team_id FROM user_last_teams WHERE user_id = ${userId}`,
      );
      const teamId = rows[0]?.team_id;
      if (!teamId) continue;
      await withTeam(db, teamId, (tx) =>
        notifyMemory(tx, teamId, [userId], { kind: "memory.scope.near_full", scope: "site" }),
      );
    } catch (err) {
      logger.error({ err, userId }, "memory near-full notice could not be sent");
    }
  }
}
