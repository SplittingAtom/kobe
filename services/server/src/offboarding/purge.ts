import {
  SYSTEM_ACTOR,
  isUnderLegalHold,
  lockLegalHolds,
  sql,
  teams,
  withTeam,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { auditTimeout } from "../retention/locks.js";
import { workspaceBlobKey } from "../workspace-sync/keys.js";
import type { Departed, OffboardingContext, TeamIdentity } from "./types.js";
import { findTeam } from "./destroy.js";

const BATCH = 500;

export type PurgeOutcome = "deleted" | "held" | "not_due" | "unavailable";

interface Counts {
  files: number;
  blobs: number;
  bytes: number;
  volumeDeleted: boolean;
}

/**
 * Every step of the purge runs in a short transaction that takes the legal-hold lock first and
 * checks the hold (KOBE-17 contract), and re-checks under the sandbox row's lock that the member
 * is still offboarded and past `retain_until` (a returning member's wake, reinstate.ts, takes the
 * same lock).
 */
async function guard(tx: KobeTx, target: Departed): Promise<"ok" | "held" | "not_due"> {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
  await lockLegalHolds(tx);
  if (await isUnderLegalHold(tx, target.teamId, target.userId)) return "held";
  const due = await tx.execute(sql`
    SELECT 1 FROM sandboxes
     WHERE team_id = ${target.teamId} AND user_id = ${target.userId}
       AND state = 'destroyed' AND retain_until IS NOT NULL AND retain_until <= now()
       FOR UPDATE`);
  return due.rowCount === 1 ? "ok" : "not_due";
}

/** Step 1: the volume (Kubernetes) goes first; the row forgets it once it is gone. */
async function deleteVolume(
  ctx: OffboardingContext,
  team: TeamIdentity,
  target: Departed,
  counts: Counts,
): Promise<PurgeOutcome | "ok"> {
  return withTeam(ctx.db, target.teamId, async (tx) => {
    const state = await guard(tx, target);
    if (state !== "ok") return state;
    const row = await tx.execute<{ pvc: string | null }>(sql`
      SELECT pvc FROM sandboxes WHERE team_id = ${target.teamId} AND user_id = ${target.userId}`);
    const pvc = row.rows[0]?.pvc;
    if (!pvc) return "ok";
    const provider = ctx.provider();
    if (!provider) return "unavailable";
    await provider.deleteVolume(team, pvc);
    await tx.execute(sql`
      UPDATE sandboxes SET pvc = NULL
       WHERE team_id = ${target.teamId} AND user_id = ${target.userId}`);
    counts.volumeDeleted = true;
    return "ok";
  });
}

/** Objects of a server-written file are the member's own only under the member's key tree. */
const ownedKey = (ctx: OffboardingContext, target: Departed, key: string): boolean =>
  ctx.blobs !== undefined &&
  key.startsWith(`${ctx.blobs.prefix}teams/${target.teamId}/users/${target.userId}/`);

/** Step 2: manifest rows and the objects they name, in batches. */
async function deleteFiles(
  ctx: OffboardingContext,
  target: Departed,
  counts: Counts,
): Promise<PurgeOutcome | "ok"> {
  for (;;) {
    const result = await withTeam(ctx.db, target.teamId, async (tx) => {
      const state = await guard(tx, target);
      if (state !== "ok") return state;
      const rows = await tx.execute<{ path: string; blob_key: string | null; size: string }>(sql`
        SELECT path, blob_key, size FROM workspace_files
         WHERE team_id = ${target.teamId} AND user_id = ${target.userId} LIMIT ${BATCH}`);
      if (rows.rows.length === 0) return "ok" as const;
      const keys = rows.rows.flatMap((r) =>
        r.blob_key && ownedKey(ctx, target, r.blob_key) ? [r.blob_key] : [],
      );
      if (keys.length > 0) await ctx.blobs?.objects.delete(keys);
      await tx.execute(sql`
        DELETE FROM workspace_files
         WHERE team_id = ${target.teamId} AND user_id = ${target.userId}
           AND path IN ${rows.rows.map((r) => r.path)}`);
      counts.files += rows.rows.length;
      return rows.rows.length < BATCH ? ("ok" as const) : ("more" as const);
    });
    if (result !== "more") return result;
  }
}

/** Step 3: the content-addressed blobs of the workspace's own prefix. */
async function deleteBlobs(
  ctx: OffboardingContext,
  target: Departed,
  counts: Counts,
): Promise<PurgeOutcome | "ok"> {
  for (;;) {
    const result = await withTeam(ctx.db, target.teamId, async (tx) => {
      const state = await guard(tx, target);
      if (state !== "ok") return state;
      const rows = await tx.execute<{ sha256: string; size: string }>(sql`
        SELECT sha256, size FROM workspace_blobs
         WHERE team_id = ${target.teamId} AND user_id = ${target.userId} LIMIT ${BATCH}`);
      if (rows.rows.length === 0) return "ok" as const;
      if (!ctx.blobs) return "unavailable" as const;
      const owner = { teamId: target.teamId, userId: target.userId };
      await ctx.blobs.objects.delete(
        rows.rows.map((r) => workspaceBlobKey(ctx.blobs?.prefix ?? "", owner, r.sha256)),
      );
      await tx.execute(sql`
        DELETE FROM workspace_blobs
         WHERE team_id = ${target.teamId} AND user_id = ${target.userId}
           AND sha256 IN ${rows.rows.map((r) => r.sha256)}`);
      counts.blobs += rows.rows.length;
      counts.bytes += rows.rows.reduce((n, r) => n + Number(r.size), 0);
      return rows.rows.length < BATCH ? ("ok" as const) : ("more" as const);
    });
    if (result !== "more") return result;
  }
}

/** Step 4: the sync state; the row stays `destroyed` (no retention left) and the purge is audited. */
async function finish(
  ctx: OffboardingContext,
  target: Departed,
  counts: Counts,
): Promise<PurgeOutcome | "ok"> {
  return withTeam(ctx.db, target.teamId, async (tx) => {
    const state = await guard(tx, target);
    if (state !== "ok") return state;
    await tx.execute(sql`
      DELETE FROM workspace_sync WHERE team_id = ${target.teamId} AND user_id = ${target.userId}`);
    await tx.execute(sql`
      UPDATE sandboxes SET retain_until = NULL, pvc = NULL
       WHERE team_id = ${target.teamId} AND user_id = ${target.userId}`);
    await auditTimeout(tx);
    await recordAudit(tx, {
      action: "sandbox.volume_deleted",
      actor: ctx.actor?.() ?? SYSTEM_ACTOR,
      teamId: target.teamId,
      target: { userId: target.userId, ...counts },
    });
    return "ok";
  });
}

/**
 * Deletes one departed member's volume and workspace copy once their 30 days are over (D12, ac-3),
 * unless a legal hold covers them (KOBE-17): then nothing is deleted and the next sweep looks
 * again. Resumable: a crash between steps leaves `retain_until` set, so the next sweep continues.
 */
export async function purgeDeparted(
  ctx: OffboardingContext,
  target: Departed,
): Promise<PurgeOutcome> {
  const team = await findTeam(ctx, target.teamId);
  if (!team) return "not_due";
  const counts: Counts = { files: 0, blobs: 0, bytes: 0, volumeDeleted: false };
  for (const step of [
    () => deleteVolume(ctx, team, target, counts),
    () => deleteFiles(ctx, target, counts),
    () => deleteBlobs(ctx, target, counts),
    () => finish(ctx, target, counts),
  ]) {
    const outcome = await step();
    if (outcome !== "ok") return outcome;
  }
  return "deleted";
}

/** Offboarded members past their retention, per team (unlocked read; `purgeDeparted` re-checks). */
export async function dueForPurge(ctx: OffboardingContext, limit: number): Promise<Departed[]> {
  const all = await ctx.db.select({ id: teams.id }).from(teams);
  const due: Departed[] = [];
  for (const team of all) {
    if (due.length >= limit) break;
    const rows = await withTeam(ctx.db, team.id, (tx) =>
      tx.execute<{ user_id: string }>(sql`
        SELECT user_id FROM sandboxes
         WHERE team_id = ${team.id} AND state = 'destroyed'
           AND retain_until IS NOT NULL AND retain_until <= now()
         ORDER BY retain_until LIMIT ${limit - due.length}`),
    );
    due.push(...rows.rows.map((r) => ({ teamId: team.id, userId: r.user_id })));
  }
  return due;
}

/** Sandboxes of members who left the team or were deactivated, but were not offboarded yet. */
export async function departedNotOffboarded(
  ctx: OffboardingContext,
  limit: number,
): Promise<Departed[]> {
  const all = await ctx.db.select({ id: teams.id }).from(teams);
  const found: Departed[] = [];
  for (const team of all) {
    if (found.length >= limit) break;
    const rows = await withTeam(ctx.db, team.id, (tx) =>
      tx.execute<{ user_id: string }>(sql`
        SELECT s.user_id FROM sandboxes s
         WHERE s.team_id = ${team.id} AND s.state <> 'destroyed'
           AND (NOT EXISTS (SELECT 1 FROM team_members m
                             WHERE m.team_id = s.team_id AND m.user_id = s.user_id)
                OR EXISTS (SELECT 1 FROM users u
                            WHERE u.id = s.user_id AND u.deactivated_at IS NOT NULL))
         LIMIT ${limit - found.length}`),
    );
    found.push(...rows.rows.map((r) => ({ teamId: team.id, userId: r.user_id })));
  }
  return found;
}
