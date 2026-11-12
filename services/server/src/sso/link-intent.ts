import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { KobeDb } from "@kobe/db";
import { SealedCookieBox, consumeOnce, rememberOnce } from "./state.js";

/**
 * The link intent of the local-proof flow (spec sso-oidc-scim §6, KOBE-630): an SSO sign-in whose
 * identity is not linked (and whose address may belong to a Kobe account) leaves
 * `{provider, subject, email, nonce, exp}` sealed in an HttpOnly cookie for 10 minutes. The next
 * local sign-in in that browser (password, with TOTP when enrolled, or a passkey) consumes it: when
 * the signed-in user's address equals the intent's, the identity is linked (`local_proof`);
 * otherwise it is discarded. The nonce is recorded server-side (digest only) and consumed with one
 * DELETE, so an intent links at most once even if the cookie were replayed.
 */

export const LINK_INTENT_TTL_MS = 10 * 60_000;
const PREFIX = "kobe:sso-link:";

const intentSchema = z.strictObject({
  v: z.literal(1),
  providerId: z.string().uuid(),
  subject: z.string().min(1).max(256),
  email: z.string().min(3).max(254),
  nonce: z.string().min(20).max(128),
  exp: z.number().int().positive(),
});

export type LinkIntent = z.infer<typeof intentSchema>;

export class LinkIntentBox extends SealedCookieBox<LinkIntent> {
  constructor(authSecret: string) {
    super(
      authSecret,
      { info: "kobe-sso-link-intent-cookie-v1", aad: Buffer.from("kobe-sso-link-intent-v1") },
      intentSchema,
    );
  }
}

/** Creates an intent, records its nonce for single use, and returns the sealed cookie value. */
export async function issueLinkIntent(
  db: KobeDb,
  box: LinkIntentBox,
  input: { readonly providerId: string; readonly subject: string; readonly email: string },
): Promise<string> {
  const exp = Date.now() + LINK_INTENT_TTL_MS;
  const nonce = randomBytes(24).toString("base64url");
  await rememberOnce(db, PREFIX, nonce, input.providerId, new Date(exp));
  return box.seal({ v: 1, ...input, nonce, exp });
}

/** Consumes an intent's nonce: true only the first time, while unexpired. */
export const consumeLinkIntent = (db: KobeDb, intent: LinkIntent): Promise<boolean> =>
  consumeOnce(db, PREFIX, intent.nonce, intent.providerId);
