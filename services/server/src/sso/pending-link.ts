import { createHash } from "node:crypto";
import { z } from "zod";
import { and, eq, gt, sql, verifications, type KobeDb } from "@kobe/db";
import type { LocalProofIdentity } from "./linking.js";

/**
 * A local proof waiting for the signed-in user's confirmation (review M1, KOBE-630): after a local
 * sign-in spent a matching link intent, the identity is staged for **that session** (10 minutes,
 * `verifications`, keyed by a digest of the session id). Nothing is linked until the person
 * confirms on a screen naming the provider and the address (`POST /v1/me/sso/pending-link/confirm`,
 * same-origin only); a new sign-in, sign-out or timeout drops it.
 */

export const PENDING_LINK_TTL_MS = 10 * 60_000;
const PREFIX = "kobe:sso-link-pending:";

const pendingSchema = z.strictObject({
  providerId: z.string().uuid(),
  subject: z.string().min(1).max(256),
  email: z.string().min(3).max(254),
  userId: z.string().uuid(),
});

export type PendingLink = z.infer<typeof pendingSchema>;

const identifierOf = (sessionId: string) =>
  `${PREFIX}${createHash("sha256").update(sessionId).digest("base64url")}`;

const parse = (value: string): PendingLink | undefined => {
  try {
    const parsed = pendingSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/** Stages the identity for the session (replacing any earlier one) and drops expired ones. */
export async function stagePendingLink(
  db: KobeDb,
  sessionId: string,
  identity: LocalProofIdentity,
  userId: string,
): Promise<void> {
  const identifier = identifierOf(sessionId);
  await db.transaction(async (tx) => {
    await tx
      .delete(verifications)
      .where(
        sql`(${verifications.identifier} = ${identifier}) OR (starts_with(${verifications.identifier}, ${PREFIX}) AND ${verifications.expiresAt} < now())`,
      );
    const value: PendingLink = {
      providerId: identity.providerId,
      subject: identity.subject,
      email: identity.email,
      userId,
    };
    await tx.insert(verifications).values({
      identifier,
      value: JSON.stringify(value),
      expiresAt: new Date(Date.now() + PENDING_LINK_TTL_MS),
    });
  });
}

/** The session's unexpired pending link of `userId`, if any. */
export async function readPendingLink(
  db: KobeDb,
  sessionId: string,
  userId: string,
): Promise<PendingLink | undefined> {
  const [row] = await db
    .select({ value: verifications.value })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, identifierOf(sessionId)),
        gt(verifications.expiresAt, sql`now()`),
      ),
    );
  const pending = row ? parse(row.value) : undefined;
  return pending?.userId === userId ? pending : undefined;
}

/** Takes (deletes) the session's pending link once: the confirm and the discard both use it. */
export async function takePendingLink(
  db: KobeDb,
  sessionId: string,
  userId: string,
): Promise<PendingLink | undefined> {
  const rows = await db
    .delete(verifications)
    .where(
      and(
        eq(verifications.identifier, identifierOf(sessionId)),
        gt(verifications.expiresAt, sql`now()`),
      ),
    )
    .returning({ value: verifications.value });
  const pending = rows[0] ? parse(rows[0].value) : undefined;
  return pending?.userId === userId ? pending : undefined;
}
