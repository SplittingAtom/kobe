import { randomBytes } from "node:crypto";
import { SessionTokenError, signJws, verifyJws } from "./jws.js";

/**
 * Site egress tokens (KOBE-343): how the **server itself** goes out through the egress proxy for
 * a site-level job (the catalog's git mirror, governed skill imports), never a sandbox. Signed with the egress proxy's
 * key like sandbox tokens, but a different audience (`kobe.egress-proxy.site`) and exact claims,
 * so neither kind ever verifies as the other. The proxy allows a site token only hosts in the
 * site egress ceiling: there is no team, user or sandbox. Only the server holds the key; the
 * token is minted per job and lives five minutes.
 */
export const SITE_EGRESS_AUDIENCE = "kobe.egress-proxy.site";
export const SITE_EGRESS_PURPOSES = ["skill-mirror", "skill-import"] as const;
export type SiteEgressPurpose = (typeof SITE_EGRESS_PURPOSES)[number];
export const SITE_EGRESS_TOKEN_TTL_SECONDS = 5 * 60;

export interface SiteEgressClaims {
  readonly iss: "kobe-server";
  readonly aud: typeof SITE_EGRESS_AUDIENCE;
  readonly sub: SiteEgressPurpose;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

const KEYS = ["iss", "aud", "sub", "iat", "exp", "jti"];
const isTime = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

function parseClaims(v: unknown): SiteEgressClaims | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  const keys = Object.keys(c);
  if (keys.length !== KEYS.length || !KEYS.every((k) => keys.includes(k))) return null;
  if (c.iss !== "kobe-server" || c.aud !== SITE_EGRESS_AUDIENCE) return null;
  if (!SITE_EGRESS_PURPOSES.includes(c.sub as SiteEgressPurpose)) return null;
  if (!isTime(c.iat) || !isTime(c.exp)) return null;
  if (typeof c.jti !== "string" || c.jti.length < 16 || c.jti.length > 128) return null;
  return c as unknown as SiteEgressClaims;
}

export function signSiteEgressToken(
  purpose: SiteEgressPurpose,
  key: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const claims: SiteEgressClaims = {
    iss: "kobe-server",
    aud: SITE_EGRESS_AUDIENCE,
    sub: purpose,
    iat: nowSeconds,
    exp: nowSeconds + SITE_EGRESS_TOKEN_TTL_SECONDS,
    jti: randomBytes(18).toString("base64url"),
  };
  return signJws(claims, key);
}

export function verifySiteEgressToken(
  token: string,
  key: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SiteEgressClaims {
  const claims = parseClaims(verifyJws(token, key));
  if (!claims) throw new SessionTokenError("claims are not a site egress token");
  if (nowSeconds >= claims.exp || claims.iat > nowSeconds + 60)
    throw new SessionTokenError("expired or issued in the future");
  return claims;
}
