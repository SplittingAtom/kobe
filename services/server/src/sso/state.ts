import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";
import { and, eq, gt, lt, sql, verifications, type KobeDb } from "@kobe/db";

/**
 * The browser-bound state of one SSO sign-in (spec sso-oidc-scim §5.3–5.4, §13; KOBE-628).
 *
 * `/sso/start` seals `{slug, provider, state, nonce, PKCE verifier, returnTo, exp}` into an
 * HttpOnly cookie (AES-256-GCM under a key derived from the auth secret, so it works without the
 * optional site envelope, which Helm-managed providers do not need) and records a SHA-256 digest
 * of `state` server-side with a 10-minute expiry. `/sso/callback` opens the cookie, compares the
 * returned `state` with the sealed one and **consumes** the digest row in one statement, so a
 * state works once: a replayed callback, a second tab's leftover or a forged cookie is refused.
 */

export const SSO_STATE_TTL_MS = 10 * 60_000;
const IDENTIFIER_PREFIX = "kobe:sso-state:";
const AAD = Buffer.from("kobe-sso-state-v1");

const flowSchema = z.strictObject({
  v: z.literal(1),
  slug: z.string().min(1).max(63),
  providerId: z.string().uuid(),
  state: z.string().min(20).max(128),
  nonce: z.string().min(20).max(128),
  verifier: z.string().min(43).max(128),
  returnTo: z.string().min(1).max(2048),
  exp: z.number().int().positive(),
});

export type SsoFlowState = z.infer<typeof flowSchema>;

/**
 * Seals and opens one kind of browser-bound SSO record (AES-256-GCM under a key HKDF-derived from
 * the auth secret with the kind's own purpose and associated data); the key never leaves the box.
 */
export class SealedCookieBox<T> {
  private readonly key: Buffer;

  constructor(
    authSecret: string,
    private readonly purpose: { readonly info: string; readonly aad: Buffer },
    private readonly schema: z.ZodType<T & { exp: number }>,
  ) {
    this.key = Buffer.from(hkdfSync("sha256", authSecret, "kobe", purpose.info, 32) as ArrayBuffer);
  }

  seal(value: T & { exp: number }): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.purpose.aad);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }

  /** The value when the cookie is authentic, well-formed and not expired; else undefined. */
  open(sealed: string | null | undefined, now = Date.now()): (T & { exp: number }) | undefined {
    if (typeof sealed !== "string" || sealed.length < 40 || sealed.length > 4096) return undefined;
    try {
      const raw = Buffer.from(sealed, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      decipher.setAAD(this.purpose.aad);
      decipher.setAuthTag(raw.subarray(12, 28));
      const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
      const parsed = this.schema.safeParse(JSON.parse(text.toString("utf8")));
      if (!parsed.success || parsed.data.exp <= now) return undefined;
      return parsed.data;
    } catch {
      return undefined;
    }
  }
}

/** Seals and opens flow cookies. */
export class SsoStateBox extends SealedCookieBox<SsoFlowState> {
  constructor(authSecret: string) {
    super(authSecret, { info: "kobe-sso-state-cookie-v1", aad: AAD }, flowSchema);
  }
}

const identifierOf = (prefix: string, key: string) =>
  `${prefix}${createHash("sha256").update(key).digest("base64url")}`;

/** Records a single-use key (its digest only) under a prefix and drops that prefix's expired ones. */
export async function rememberOnce(
  db: KobeDb,
  prefix: string,
  key: string,
  value: string,
  expiresAt: Date,
): Promise<void> {
  await db
    .delete(verifications)
    .where(
      and(
        sql`starts_with(${verifications.identifier}, ${prefix})`,
        lt(verifications.expiresAt, sql`now()`),
      ),
    );
  await db
    .insert(verifications)
    .values({ identifier: identifierOf(prefix, key), value, expiresAt });
}

/** Consumes a single-use key once: true only for the first caller while it is unexpired. */
export async function consumeOnce(
  db: KobeDb,
  prefix: string,
  key: string,
  value: string,
): Promise<boolean> {
  const rows = await db
    .delete(verifications)
    .where(
      and(
        eq(verifications.identifier, identifierOf(prefix, key)),
        eq(verifications.value, value),
        gt(verifications.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: verifications.id });
  return rows.length > 0;
}

/** Records a new state (digest only) and drops expired ones. */
export const rememberState = (db: KobeDb, state: string, slug: string, expiresAt: Date) =>
  rememberOnce(db, IDENTIFIER_PREFIX, state, slug, expiresAt);

/** Consumes a state once: true only for the first caller while it is unexpired. */
export const consumeState = (db: KobeDb, state: string, slug: string) =>
  consumeOnce(db, IDENTIFIER_PREFIX, state, slug);
