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
  /**
   * The tenant's verified domains as the admin listed them (`allowed_email_domains`): an Entra UPN
   * in one of them counts as a verified address. Absent or empty: no UPN is verified.
   */
  readonly allowedEmailDomains?: readonly string[];
}

export interface VerifiedIdentity {
  readonly subject: string;
  /**
   * Lower-cased address. Generic: `email`. Entra: `email` only when `xms_edov` is true, else the UPN
   * (`upn`, then `preferred_username`): users can edit their own `email` (the "nOAuth" takeover).
   * Null when none.
   */
  readonly email: string | null;
  /**
   * The address is verified (review finding 1): generic `email_verified === true`; Entra `email`
   * with `xms_edov === true`, or a UPN whose domain is one of the provider's verified domains. Only
   * a verified address matches team invitations; it is never proof for linking (§6).
   */
  readonly emailVerified: boolean;
  readonly name: string | null;
  /** Access values (app roles or group ids); null on a groups overage. */
  readonly values: readonly string[] | null;
  readonly amr: readonly string[];
  readonly acr: string | null;
  /** Entra authentication contexts (`acrs`, §8): an array, or a single string; else empty. */
  readonly acrs: readonly string[];
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

function addressIn(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

function addressOf(
  claims: Claims,
  p: ClaimsProvider,
): { readonly email: string | null; readonly verified: boolean } {
  if (p.kind !== "entra") {
    const email = addressIn(claims.email);
    return { email, verified: email !== null && claims.email_verified === true };
  }
  if (claims.xms_edov === true) {
    const email = addressIn(claims.email);
    if (email !== null) return { email, verified: true };
  }
  const fromUpn = addressIn(claims.upn);
  const upn = fromUpn ?? addressIn(claims.preferred_username);
  if (upn === null) return { email: null, verified: false };
  const domain = upn.slice(upn.lastIndexOf("@") + 1);
  // Only the `upn` claim of a member counts (KOBE-630 review L1): `preferred_username` is a
  // guest's home sign-in name, and a guest (`#EXT#`, or an `idp` other than the tenant) has a UPN
  // the tenant did not verify.
  const guest =
    upn.includes("#ext#") || (typeof claims.idp === "string" && claims.idp !== claims.iss);
  return {
    email: upn,
    verified: fromUpn !== null && !guest && (p.allowedEmailDomains ?? []).includes(domain),
  };
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
  const acrsRaw = typeof claims.acrs === "string" ? [claims.acrs] : claims.acrs;
  const acrs = Array.isArray(acrsRaw)
    ? acrsRaw.filter((v): v is string => typeof v === "string" && v.length <= 64).slice(0, AMR_MAX)
    : [];
  const address = addressOf(claims, p);
  return {
    ok: true,
    identity: {
      subject,
      email: address.email,
      emailVerified: address.verified,
      name: nameOf(claims),
      values: valuesOf(claims, p.accessClaim),
      amr,
      acr: str(claims.acr, VALUE_MAX),
      acrs,
      authTime: isNum(claims.auth_time) ? new Date(claims.auth_time * 1000) : null,
    },
  };
}
