import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull, scimTokens, sql, ssoProviders, type KobeDb } from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * SCIM bearer tokens (KOBE-631, spec sso-oidc-scim §10): 32 random bytes as
 * `kobe_scim_<base64url>`, shown once, stored only as a SHA-256 hash with a short display prefix.
 * Rotation issues a second token while the first keeps working until it is revoked (at most two
 * live per provider). Revocation is final (a trigger refuses to undo it). A token works only for
 * its own provider. Audit rows carry the token row's id (`credentialId`), never the token.
 */
export const SCIM_TOKEN_PREFIX = "kobe_scim_";
/** Live tokens per provider: the current one and its replacement during a rotation. */
export const SCIM_MAX_LIVE_TOKENS = 2;
const TOKEN_SHAPE = /^kobe_scim_[A-Za-z0-9_-]{43}$/;
/** Characters of the token kept for display (`kobe_scim_` plus four). */
const DISPLAY_CHARS = SCIM_TOKEN_PREFIX.length + 4;

export const hashScimToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export interface ScimTokenView {
  readonly id: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

const COLUMNS = {
  id: scimTokens.id,
  prefix: scimTokens.prefix,
  createdAt: scimTokens.createdAt,
  lastUsedAt: scimTokens.lastUsedAt,
  revokedAt: scimTokens.revokedAt,
};

function viewOf(r: {
  id: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}): ScimTokenView {
  return {
    id: r.id,
    prefix: r.prefix,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
  };
}

/** A provider's tokens, newest first (revoked ones included, for the record). */
export async function listScimTokens(db: KobeDb, providerId: string): Promise<ScimTokenView[]> {
  const rows = await db
    .select(COLUMNS)
    .from(scimTokens)
    .where(eq(scimTokens.providerId, providerId))
    .orderBy(desc(scimTokens.createdAt));
  return rows.map(viewOf);
}

export type CreateTokenOutcome =
  | { readonly ok: true; readonly token: string; readonly view: ScimTokenView }
  | { readonly ok: false; readonly failure: "not_found" | "too_many_tokens" };

/**
 * Issues a token for the provider (create, or the new half of a rotation). Refused while two are
 * live: revoke one first. The provider row is locked so two concurrent creates can't make three.
 */
export async function createScimToken(
  db: KobeDb,
  providerId: string,
  createdBy: string,
): Promise<CreateTokenOutcome> {
  return db.transaction(async (tx) => {
    const [provider] = await tx
      .select({ id: ssoProviders.id })
      .from(ssoProviders)
      .where(eq(ssoProviders.id, providerId))
      .for("update");
    if (!provider) return { ok: false, failure: "not_found" } as const;
    const [live] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(scimTokens)
      .where(and(eq(scimTokens.providerId, providerId), isNull(scimTokens.revokedAt)));
    if ((live?.n ?? 0) >= SCIM_MAX_LIVE_TOKENS) {
      return { ok: false, failure: "too_many_tokens" } as const;
    }
    const token = SCIM_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const [row] = await tx
      .insert(scimTokens)
      .values({
        providerId,
        tokenHash: hashScimToken(token),
        prefix: token.slice(0, DISPLAY_CHARS),
        createdBy,
      })
      .returning(COLUMNS);
    if (!row) throw new Error("scim token insert returned no row");
    await recordAudit(tx, {
      action: "identity.scim.token.created",
      target: { providerId, credentialId: row.id },
    });
    return { ok: true, token, view: viewOf(row) } as const;
  });
}

export type RevokeTokenOutcome =
  | { readonly ok: true; readonly view: ScimTokenView }
  | { readonly ok: false; readonly failure: "not_found" | "already_revoked" };

/** Revokes a token for good; the next request with it gets 401. */
export async function revokeScimToken(
  db: KobeDb,
  providerId: string,
  tokenId: string,
): Promise<RevokeTokenOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(scimTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(scimTokens.id, tokenId),
          eq(scimTokens.providerId, providerId),
          isNull(scimTokens.revokedAt),
        ),
      )
      .returning(COLUMNS);
    if (!row) {
      const [exists] = await tx
        .select({ id: scimTokens.id })
        .from(scimTokens)
        .where(and(eq(scimTokens.id, tokenId), eq(scimTokens.providerId, providerId)));
      return { ok: false, failure: exists ? "already_revoked" : "not_found" } as const;
    }
    await recordAudit(tx, {
      action: "identity.scim.token.revoked",
      target: { providerId, credentialId: tokenId },
    });
    return { ok: true, view: viewOf(row) } as const;
  });
}

/** The caller a valid SCIM token stands for. */
export interface ScimCaller {
  readonly credentialId: string;
  readonly provider: {
    readonly id: string;
    readonly slug: string;
    readonly kind: "entra" | "oidc";
    readonly enabled: boolean;
    /** The tenant's verified domains (`allowed_email_domains`): see `scimAddressVerified`. */
    readonly allowedEmailDomains: readonly string[];
  };
}

/** The bearer token of an `Authorization` header, or undefined. */
export function bearerOf(header: string | undefined): string | undefined {
  const m = /^Bearer[ ]+(\S+)\s*$/i.exec(header ?? "");
  return m?.[1];
}

/**
 * Authenticates a SCIM request for the provider `slug`: only that provider's live tokens are
 * compared (constant-time, on the SHA-256 hashes), so a token of another provider, a revoked token
 * or a malformed one all fail the same way. Marks the token used.
 */
export async function authenticateScim(
  db: KobeDb,
  slug: string,
  token: string | undefined,
): Promise<ScimCaller | undefined> {
  const candidates = await db
    .select({
      id: scimTokens.id,
      tokenHash: scimTokens.tokenHash,
      providerId: ssoProviders.id,
      kind: ssoProviders.kind,
      enabled: ssoProviders.enabled,
      allowedEmailDomains: ssoProviders.allowedEmailDomains,
    })
    .from(scimTokens)
    .innerJoin(ssoProviders, eq(ssoProviders.id, scimTokens.providerId))
    .where(and(eq(ssoProviders.slug, slug), isNull(scimTokens.revokedAt)));
  // Hash even a malformed token, so every failure costs the same.
  const presented = Buffer.from(hashScimToken(token ?? ""), "utf8");
  let match: (typeof candidates)[number] | undefined;
  for (const c of candidates) {
    if (timingSafeEqual(Buffer.from(c.tokenHash, "utf8"), presented)) match = c;
  }
  if (!match || token === undefined || !TOKEN_SHAPE.test(token)) return undefined;
  // Conditional: a revocation committed since the read wins (no use is recorded for it).
  const used = await db
    .update(scimTokens)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(scimTokens.id, match.id), isNull(scimTokens.revokedAt)))
    .returning({ id: scimTokens.id });
  if (used.length === 0) return undefined;
  return {
    credentialId: match.id,
    provider: {
      id: match.providerId,
      slug,
      kind: match.kind,
      enabled: match.enabled,
      allowedEmailDomains: match.allowedEmailDomains,
    },
  };
}
