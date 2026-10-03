import { createHash } from "node:crypto";
import { eq, sql, verifications, type KobeDb, type KobeTx } from "@kobe/db";

/**
 * While a reset link mailed less than this long ago is still valid, further requests send nothing
 * (stops mail bombing). It never blocks for longer, and only a delivered email counts, so an
 * attacker's requests can't lock the account owner out of resetting.
 */
export const RESET_RESEND_AFTER_MS = 5 * 60_000;

const sentKey = (userId: string) => `kobe:reset-sent:${userId}:`;

/** Better Auth's stored identifier for a reset token (verification.storeIdentifier: "hashed"). */
export function storedResetIdentifier(token: string): string {
  return createHash("sha256").update(`reset-password:${token}`).digest("base64url");
}

/** Whether a reset link mailed (or being mailed) within RESET_RESEND_AFTER_MS is still valid. */
async function recentResetLinkPending(tx: KobeTx, userId: string, now: number): Promise<boolean> {
  const prefix = sentKey(userId);
  const result = await tx.execute(sql`
    SELECT 1 FROM rate_limits r
    JOIN verifications v ON r.key = ${prefix} || v.identifier
    WHERE r.key LIKE ${`${prefix}%`} AND r.last_request > ${now - RESET_RESEND_AFTER_MS}
      AND v.value = ${userId} AND v.expires_at > ${new Date(now)}
    LIMIT 1`);
  return result.rows.length > 0;
}

/**
 * Claims the sending of `token`'s link: false while a link mailed, or being mailed, in the last
 * RESET_RESEND_AFTER_MS is still valid. Check and claim are one step per user (advisory lock), so
 * requests arriving while an email is still on its way to the SMTP server can't all pass the
 * check. Call releaseResetLinkClaim when the email isn't delivered: only a delivered email counts.
 */
export async function claimResetLinkSend(
  db: KobeDb,
  userId: string,
  token: string,
  now = Date.now(),
): Promise<boolean> {
  const prefix = sentKey(userId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${prefix}, 0))`);
    if (await recentResetLinkPending(tx, userId, now)) return false;
    // Forget claims older than the resend window.
    await tx.execute(sql`
      DELETE FROM rate_limits WHERE key LIKE ${`${prefix}%`}
        AND last_request <= ${now - RESET_RESEND_AFTER_MS}`);
    await tx.execute(sql`
      INSERT INTO rate_limits (key, count, last_request)
      VALUES (${prefix + storedResetIdentifier(token)}, 1, ${now})
      ON CONFLICT (key) DO UPDATE SET last_request = EXCLUDED.last_request`);
    return true;
  });
}

/** Drops the claim of an email that wasn't delivered, so the next request is mailed at once. */
export async function releaseResetLinkClaim(
  db: KobeDb,
  userId: string,
  token: string,
): Promise<void> {
  await db.execute(
    sql`DELETE FROM rate_limits WHERE key = ${sentKey(userId) + storedResetIdentifier(token)}`,
  );
}

/**
 * Invalidates every outstanding reset link (and other pending verifications) of a user, as
 * deactivation does: after a reset or a password change, an older mailed link must not work.
 */
export async function revokeResetLinks(db: KobeDb, userId: string): Promise<void> {
  await db.delete(verifications).where(eq(verifications.value, userId));
  await db.execute(sql`DELETE FROM rate_limits WHERE key LIKE ${`${sentKey(userId)}%`}`);
}
