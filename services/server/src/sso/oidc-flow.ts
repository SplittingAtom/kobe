import * as oidc from "openid-client";
import { and, asc, eq, ssoProviders, type KobeDb } from "@kobe/db";
import {
  ALLOWED_ID_TOKEN_ALGS,
  CLOCK_TOLERANCE_S,
  checkIdTokenClaims,
  type SsoFailure,
  type VerifiedIdentity,
} from "./claims.js";
import { discoverProvider } from "./discovery.js";
import { acrsClaimsParameter } from "./mfa.js";
import { SsoNetError, guardedFetch, type SsoNet } from "./net.js";
import type { MfaRule } from "./schemas.js";

/**
 * The OIDC half of SSO sign-in (spec sso-oidc-scim §5; KOBE-628) on `openid-client` 6: discovery
 * (validated like the console's Test, cached for an hour), the authorization request (code, PKCE
 * S256, `state`, `nonce`) and the code exchange with ID token validation. The IdP is contacted only
 * from here, i.e. only by the SSO routes: local sign-in never waits on it (break-glass, SSO10).
 */

export const DISCOVERY_TTL_MS = 60 * 60_000;
/** A failed discovery is remembered this long per provider (review finding 9c). */
export const DISCOVERY_FAILURE_TTL_MS = 60_000;
export const SSO_SCOPE = "openid profile email";

export interface SsoProvider {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly kind: "entra" | "oidc";
  readonly issuer: string;
  readonly clientId: string;
  readonly tenantId: string | null;
  readonly subjectClaim: "oid" | "sub";
  readonly accessClaim: "roles" | "groups";
  readonly jitProvisioning: boolean;
  readonly mfaRule: MfaRule;
  /** The tenant's verified domains: a UPN in one counts as a verified address (claims.ts). */
  readonly allowedEmailDomains: readonly string[];
  /** Caps the provider's SSO sessions (§9); null: the ordinary session lifetime. */
  readonly maxSessionHours: number | null;
}

const PROVIDER_COLUMNS = {
  id: ssoProviders.id,
  slug: ssoProviders.slug,
  displayName: ssoProviders.displayName,
  kind: ssoProviders.kind,
  issuer: ssoProviders.issuer,
  clientId: ssoProviders.clientId,
  tenantId: ssoProviders.tenantId,
  subjectClaim: ssoProviders.subjectClaim,
  accessClaim: ssoProviders.accessClaim,
  jitProvisioning: ssoProviders.jitProvisioning,
  mfaRule: ssoProviders.mfaRule,
  allowedEmailDomains: ssoProviders.allowedEmailDomains,
  maxSessionHours: ssoProviders.maxSessionHours,
};

/** An enabled provider by slug (a disabled or unknown one is undefined). */
export async function loadEnabledProvider(
  db: KobeDb,
  slug: string,
): Promise<SsoProvider | undefined> {
  const [row] = await db
    .select(PROVIDER_COLUMNS)
    .from(ssoProviders)
    .where(and(eq(ssoProviders.slug, slug), eq(ssoProviders.enabled, true)));
  return row ? { ...row, mfaRule: row.mfaRule as MfaRule } : undefined;
}

/** The sign-in page's buttons: enabled providers, slug and display name only. */
export async function listSignInProviders(
  db: KobeDb,
  helmSecrets: ReadonlyMap<string, string>,
): Promise<{ slug: string; displayName: string }[]> {
  const rows = await db
    .select({
      slug: ssoProviders.slug,
      displayName: ssoProviders.displayName,
      managedBy: ssoProviders.managedBy,
    })
    .from(ssoProviders)
    .where(eq(ssoProviders.enabled, true))
    .orderBy(asc(ssoProviders.displayName));
  // A Helm provider whose Secret is not mounted could never finish a sign-in: no button.
  return rows
    .filter((r) => r.managedBy !== "helm" || helmSecrets.has(r.slug))
    .map(({ slug, displayName }) => ({ slug, displayName }));
}

/** The flow could not continue; `failure` is the `sso_error` code. Never carries IdP content. */
export class SsoFlowError extends Error {
  constructor(readonly failure: SsoFailure) {
    super(failure);
    this.name = "SsoFlowError";
  }
}

function netFailureIn(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; depth < 6 && e; depth++) {
    if (e instanceof SsoNetError) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

interface Cached {
  readonly metadata: oidc.ServerMetadata;
  readonly at: number;
  jwks?: oidc.ExportedJWKSCache;
}

/** Builds `openid-client` configurations from validated, cached discovery. One per process. */
export class OidcClients {
  private readonly cache = new Map<string, Cached>();
  /** When discovery last failed, per provider key: refused without a request for a minute. */
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly net: SsoNet,
    private readonly now: () => number = Date.now,
  ) {}

  private key(p: SsoProvider): string {
    return `${p.kind}|${p.issuer}|${p.tenantId ?? ""}`;
  }

  private async metadata(p: SsoProvider): Promise<Cached> {
    const key = this.key(p);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < DISCOVERY_TTL_MS) return hit;
    const failedAt = this.failures.get(key);
    if (failedAt !== undefined && this.now() - failedAt < DISCOVERY_FAILURE_TTL_MS) {
      throw new SsoFlowError("idp_unreachable");
    }
    try {
      const entry = await this.discover(p);
      this.failures.delete(key);
      this.cache.set(key, entry);
      return entry;
    } catch (err) {
      this.failures.set(key, this.now());
      throw err;
    }
  }

  private async discover(p: SsoProvider): Promise<Cached> {
    const target =
      p.kind === "entra"
        ? ({ kind: "entra", tenantId: p.tenantId ?? "" } as const)
        : ({ kind: "oidc", issuer: p.issuer } as const);
    const { report, metadata } = await discoverProvider(this.net, target);
    // The issuer discovery pins must still be the one stored (a changed tenant is re-saved).
    if (!report.ok || !metadata || report.issuer !== p.issuer) {
      throw new SsoFlowError("idp_unreachable");
    }
    return { metadata, at: this.now() };
  }

  /** A configuration for one provider and secret; throws {@link SsoFlowError}. */
  async configure(p: SsoProvider, clientSecret: string): Promise<oidc.Configuration> {
    const cached = await this.metadata(p);
    const meta = cached.metadata;
    const advertised = meta.id_token_signing_alg_values_supported ?? ["RS256"];
    const algs = ALLOWED_ID_TOKEN_ALGS.filter((a) => advertised.includes(a));
    if (algs.length === 0) throw new SsoFlowError("token_invalid");
    const methods = meta.token_endpoint_auth_methods_supported;
    const auth =
      methods === undefined || methods.includes("client_secret_basic")
        ? oidc.ClientSecretBasic(clientSecret)
        : oidc.ClientSecretPost(clientSecret);
    const config = new oidc.Configuration(
      meta,
      p.clientId,
      {
        // oauth4webapi accepts a list here (`includes`); the header is checked again in claims.ts.
        id_token_signed_response_alg: (algs.length === 1 ? algs[0] : algs) as string,
        [oidc.clockTolerance]: CLOCK_TOLERANCE_S,
      },
      auth,
    );
    config[oidc.customFetch] = guardedFetch(this.net);
    config.timeout = Math.ceil(this.net.timeoutMs / 1000);
    // Verify the ID token's signature against the provider's JWKS (not only TLS).
    oidc.enableNonRepudiationChecks(config);
    if (cached.jwks) oidc.setJwksCache(config, cached.jwks);
    return config;
  }

  /** Keeps the JWKS the exchange fetched for the next sign-in (refetched on an unknown `kid`). */
  rememberJwks(p: SsoProvider, config: oidc.Configuration): void {
    const entry = this.cache.get(this.key(p));
    const jwks = oidc.getJwksCache(config);
    if (entry && jwks) entry.jwks = jwks;
  }
}

export interface StartParams {
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

export function authorizationUrl(config: oidc.Configuration, p: SsoProvider, s: StartParams): URL {
  const claims = acrsClaimsParameter(p.kind, p.mfaRule);
  return oidc.buildAuthorizationUrl(config, {
    response_type: "code",
    redirect_uri: s.redirectUri,
    scope: SSO_SCOPE,
    state: s.state,
    nonce: s.nonce,
    code_challenge: s.codeChallenge,
    code_challenge_method: "S256",
    ...(p.kind === "entra" ? { prompt: "select_account" } : {}),
    // Entra: ask for the MFA authentication context as an essential `acrs` claim (§8, KOBE-629).
    ...(claims === undefined ? {} : { claims }),
  });
}

function headerOf(idToken: string): Record<string, unknown> {
  try {
    const part = idToken.split(".")[0] ?? "";
    const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Exchanges the code (PKCE verifier, expected state and nonce) and returns the identity from the
 * validated ID token. Claims come only from the ID token; UserInfo is never called.
 */
export async function exchangeCode(
  clients: OidcClients,
  config: oidc.Configuration,
  p: SsoProvider,
  input: {
    readonly callbackUrl: URL;
    readonly verifier: string;
    readonly state: string;
    readonly nonce: string;
  },
): Promise<VerifiedIdentity> {
  let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
  try {
    tokens = await oidc.authorizationCodeGrant(config, input.callbackUrl, {
      pkceCodeVerifier: input.verifier,
      expectedState: input.state,
      expectedNonce: input.nonce,
      idTokenExpected: true,
    });
  } catch (error) {
    if (error instanceof SsoFlowError) throw error;
    if (netFailureIn(error)) throw new SsoFlowError("idp_unreachable");
    if (error instanceof oidc.AuthorizationResponseError) throw new SsoFlowError("idp_error");
    throw new SsoFlowError("token_invalid");
  }
  clients.rememberJwks(p, config);
  const claims = tokens.claims();
  if (!tokens.id_token || !claims) throw new SsoFlowError("token_invalid");
  const checked = checkIdTokenClaims({
    header: headerOf(tokens.id_token),
    claims: claims as unknown as Record<string, unknown>,
    provider: p,
    expectedNonce: input.nonce,
  });
  if (!checked.ok) throw new SsoFlowError(checked.failure);
  return checked.identity;
}
