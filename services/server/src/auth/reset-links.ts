import { createHash } from "node:crypto";
import { eq, sql, verifications, type KobeDb } from "@kobe/db";

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

/** Whether a reset link mailed within RESET_RESEND_AFTER_MS is still unused and unexpired. */
export async function recentResetLinkPending(
  db: KobeDb,
  userId: string,
  now = Date.now(),
): Promise<boolean> {
  const prefix = sentKey(userId);
  const result = await db.execute(sql`
    SELECT 1 FROM rate_limits r
    JOIN verifications v ON r.key = ${prefix} || v.identifier
    WHERE r.key LIKE ${`${prefix}%`} AND r.last_request > ${now - RESET_RESEND_AFTER_MS}
      AND v.value = ${userId} AND v.expires_at > ${new Date(now)}
    LIMIT 1`);
  return result.rows.length > 0;
}

/** Records a delivered reset email (and forgets ones older than the resend window). */
export async function recordResetLinkSent(
  db: KobeDb,
  userId: string,
  token: string,
  now = Date.now(),
): Promise<void> {
  const prefix = sentKey(userId);
  await db.execute(sql`
    DELETE FROM rate_limits WHERE key LIKE ${`${prefix}%`}
      AND last_request <= ${now - RESET_RESEND_AFTER_MS}`);
  await db.execute(sql`
    INSERT INTO rate_limits (key, count, last_request)
    VALUES (${prefix + storedResetIdentifier(token)}, 1, ${now})
    ON CONFLICT (key) DO UPDATE SET last_request = EXCLUDED.last_request`);
}

/**
 * Invalidates every outstanding reset link (and other pending verifications) of a user, as
 * deactivation does: after a reset or a password change, an older mailed link must not work.
 */
export async function revokeResetLinks(db: KobeDb, userId: string): Promise<void> {
  await db.delete(verifications).where(eq(verifications.value, userId));
  await db.execute(sql`DELETE FROM rate_limits WHERE key LIKE ${`${sentKey(userId)}%`}`);
}
