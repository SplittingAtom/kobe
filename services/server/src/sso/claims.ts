/**
 * Kobe's own checks on a validated ID token (spec sso-oidc-scim §5.4–5.5, §7, §13; KOBE-628), run
 * after `openid-client` verified the signature (JWKS), `iss`, `aud`, `nonce` and the time claims.
 * They are deliberately repeated here, so a library default can never loosen them:
 *
 * - `alg` is RS256 or ES256 (never `none`, never HS* keyed with the client secret);
 * - `iss` equals the configured, tenant-specific issuer exactly; Entra `tid` equals the tenant id;
 * - `aud` names the client id, and `azp` (required when there are several audiences) is the client;
 * - `exp`, `nbf`, `iat` and `auth_time` (at most 10 minutes old) with 60 seconds of clock tolerance;
 * - the subject comes from the provider's `subject_claim` (Entra `oid`), never from email;
 * - a groups overage (`_claim_names.groups`, `hasgroups`) is reported, never resolved through Graph.
 *
 * Only ids, codes and booleans leave this module in errors: never claims or tokens.
 */

export const ALLOWED_ID_TOKEN_ALGS = ["RS256", "ES256"] as const;
export const CLOCK_TOLERANCE_S = 60;
export const AUTH_TIME_MAX_AGE_S = 10 * 60;
const SUBJECT_MAX = 256;
const VALUE_MAX = 256;
const AMR_MAX = 32;

/** Why an SSO sign-in was refused: the `sso_error` code and the audit reason. */
export type SsoFailure =
  | "state_invalid"
  | "token_invalid"
  | "tenant_mismatch"
  | "no_access"
  | "mfa_missing"
  | "link_required"
  | "deactivated"
  | "groups_overage"
  | "email_missing"
  | "provider_unavailable"
  | "idp_unreachable"
  | "idp_error"
  | "sign_in_failed";

export interface ClaimsProvider {
  readonly kind: "entra" | "oidc";
  readonly issuer: string;
  readonly clientId: string;
  readonly tenantId: string | null;
  readonly subjectClaim: "oid" | "sub";
  readonly accessClaim: "roles" | "groups";
}

export interface VerifiedIdentity {
  readonly subject: string;
  /** Lower-cased address from `email` (Entra: else `preferred_username`); null when none. */
  readonly email: string | null;
  /** The token vouches for the address (`email_verified`; Entra `xms_edov`). Not proof (§6). */
  readonly emailVerified: boolean;
  readonly name: string | null;
  /** Access values (app roles or group ids); null on a groups overage. */
  readonly values: readonly string[] | null;
  readonly amr: readonly string[];
  readonly acr: string | null;
  readonly authTime: Date | null;
}

export type ClaimsCheck =
  | { readonly ok: true; readonly identity: VerifiedIdentity }
  | { readonly ok: false; readonly failure: SsoFailure; readonly check: string };

type Claims = Readonly<Record<string, unknown>>;

const refuse = (failure: SsoFailure, check: string): ClaimsCheck => ({
  ok: false,
  failure,
  check,
});
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

function emailOf(claims: Claims, kind: ClaimsProvider["kind"]): string | null {
  const candidates = kind === "entra" ? [claims.email, claims.preferred_username] : [claims.email];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const e = c.trim().toLowerCase();
    if (e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return e;
  }
  return null;
}

function nameOf(claims: Claims): string | null {
  if (typeof claims.name !== "string") return null;
  const n = claims.name
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .trim()
    .slice(0, 100);
  return n === "" ? null : n;
}

function valuesOf(claims: Claims, accessClaim: ClaimsProvider["accessClaim"]): string[] | null {
  if (accessClaim === "groups") {
    const names = claims._claim_names as Record<string, unknown> | undefined;
    const overage =
      (typeof names === "object" && names !== null && "groups" in names) ||
      claims.hasgroups === true ||
      claims.hasgroups === "true";
    if (overage) return null;
  }
  const raw = claims[accessClaim];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.length <= VALUE_MAX);
}

function audienceOk(claims: Claims, clientId: string): boolean {
  const aud = claims.aud;
  const list = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (!list.includes(clientId)) return false;
  if (claims.azp !== undefined && claims.azp !== clientId) return false;
  if (list.length > 1 && claims.azp !== clientId) return false;
  return true;
}

function timesOk(claims: Claims, nowS: number): string | null {
  const t = CLOCK_TOLERANCE_S;
  if (!isNum(claims.exp) || claims.exp + t <= nowS) return "exp";
  if (!isNum(claims.iat) || claims.iat - t > nowS) return "iat";
  if (claims.nbf !== undefined && (!isNum(claims.nbf) || claims.nbf - t > nowS)) return "nbf";
  if (claims.auth_time !== undefined) {
    const at = claims.auth_time;
    if (!isNum(at) || at - t > nowS || nowS - at > AUTH_TIME_MAX_AGE_S + t) return "auth_time";
  }
  return null;
}

export function checkIdTokenClaims(input: {
  readonly header: Readonly<Record<string, unknown>>;
  readonly claims: Claims;
  readonly provider: ClaimsProvider;
  readonly expectedNonce: string;
  readonly nowS?: number;
}): ClaimsCheck {
  const { header, claims, provider: p } = input;
  const nowS = input.nowS ?? Math.floor(Date.now() / 1000);
  if (!(ALLOWED_ID_TOKEN_ALGS as readonly unknown[]).includes(header.alg)) {
    return refuse("token_invalid", "alg");
  }
  if (claims.iss !== p.issuer) {
    return refuse(p.kind === "entra" ? "tenant_mismatch" : "token_invalid", "iss");
  }
  if (p.kind === "entra") {
    const tid = typeof claims.tid === "string" ? claims.tid.toLowerCase() : null;
    if (tid === null || tid !== p.tenantId?.toLowerCase()) return refuse("tenant_mismatch", "tid");
  }
  if (!audienceOk(claims, p.clientId)) return refuse("token_invalid", "aud");
  if (claims.nonce !== input.expectedNonce) return refuse("token_invalid", "nonce");
  const badTime = timesOk(claims, nowS);
  if (badTime) return refuse("token_invalid", badTime);
  const subject = str(claims[p.subjectClaim], SUBJECT_MAX);
  if (subject === null) return refuse("token_invalid", "subject");
  const amr = Array.isArray(claims.amr)
    ? claims.amr
        .filter((v): v is string => typeof v === "string" && v.length <= 64)
        .slice(0, AMR_MAX)
    : [];
  const email = emailOf(claims, p.kind);
  return {
    ok: true,
    identity: {
      subject,
      email,
      emailVerified:
        email !== null &&
        (p.kind === "entra" ? claims.xms_edov === true : claims.email_verified === true),
      name: nameOf(claims),
      values: valuesOf(claims, p.accessClaim),
      amr,
      acr: str(claims.acr, VALUE_MAX),
      authTime: isNum(claims.auth_time) ? new Date(claims.auth_time * 1000) : null,
    },
  };
}
