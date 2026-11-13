import * as oidc from "openid-client";
import { issuerFor, type IssuerFailure } from "./issuer.js";
import { SsoNetError, checkSsoUrl, guardedFetch, type SsoNet, type SsoNetFailure } from "./net.js";

/**
 * Discovery validation of a provider (spec sso-oidc-scim §4, §5.1–5.2; KOBE-626), run when a
 * provider is saved and by the console's Test button. Uses `openid-client` 6 for the discovery
 * request, through {@link guardedFetch}, then checks what Kobe requires on top of it:
 *
 * - the issuer is tenant-specific (`common`/`organizations`/`consumers` refused, Entra built from
 *   the tenant id);
 * - the discovery URL passes the SSRF guard (https, public address or an allowed CIDR);
 * - the document's `issuer` equals the configured issuer **exactly** (openid-client itself lets an
 *   Entra or B2C issuer differ, for multi-tenant apps; Kobe never does);
 * - `code` is a supported response type;
 * - PKCE S256 is advertised (Entra supports it without advertising it: the Entra preset assumes it);
 * - the authorization, token and JWKS endpoints are https and pass the SSRF guard.
 *
 * The report lists each check with a plain message and never carries the document, a URL's query or
 * a response body.
 */

export type DiscoveryCheckId =
  | "tenant_pinned"
  | "address_allowed"
  | "reachable"
  | "issuer_match"
  | "code_flow"
  | "pkce_s256"
  | "endpoints_allowed";

export type DiscoveryFailure =
  | IssuerFailure
  | SsoNetFailure
  | "not_discovery_document"
  | "issuer_mismatch"
  | "no_code_flow"
  | "no_pkce_s256"
  | "endpoint_not_allowed";

export interface DiscoveryCheck {
  readonly id: DiscoveryCheckId;
  readonly ok: boolean;
  readonly message: string;
}

export interface DiscoveryReport {
  readonly ok: boolean;
  /** The issuer the provider must name (Entra: built from the tenant id); null when invalid. */
  readonly issuer: string | null;
  readonly checks: readonly DiscoveryCheck[];
  /** The first failed check's code; absent when every check passed. */
  readonly failure?: DiscoveryFailure;
  /** That failure in a sentence; absent when every check passed. */
  readonly message?: string;
}

export type DiscoveryTarget =
  | { readonly kind: "entra"; readonly tenantId: string }
  | { readonly kind: "oidc"; readonly issuer: string };

/** oauth4webapi's code for "discovered issuer differs" (not re-exported by openid-client). */
const JSON_ATTRIBUTE_COMPARISON = "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED";

const NET_MESSAGES: Readonly<Record<SsoNetFailure, string>> = {
  https_required: "The identity provider must be reached over https.",
  address_not_allowed:
    "The identity provider's address is private, link-local or otherwise not allowed. For an on-premises provider, add its range to auth.sso.allowedInternalCidrs.",
  host_unresolvable: "The identity provider's host name does not resolve.",
  port_not_allowed: "That port is not allowed for identity providers on this site.",
  invalid_url: "That is not a valid identity provider URL.",
  redirect_refused: "The discovery URL answered with a redirect; Kobe does not follow redirects.",
  unreachable: "The discovery document could not be fetched (unreachable, timed out or not 200).",
  too_large: "The discovery document is too large.",
};

const MESSAGES = {
  not_discovery_document: "The answer is not an OpenID Connect discovery document.",
  issuer_mismatch:
    "The discovery document names a different issuer than the one configured (or a multi-tenant one).",
  no_code_flow: "The provider does not support the authorization code flow.",
  no_pkce_s256: "The provider does not support PKCE with S256.",
  endpoint_not_allowed:
    "An endpoint in the discovery document is not https or points at an address that is not allowed.",
} as const;

const PASSED: Readonly<Record<DiscoveryCheckId, string>> = {
  tenant_pinned: "The issuer is tenant-specific.",
  address_allowed: "The discovery URL is https on an allowed address.",
  reachable: "The discovery document was fetched.",
  issuer_match: "The document's issuer equals the configured issuer.",
  code_flow: "The authorization code flow is supported.",
  pkce_s256: "PKCE with S256 is supported.",
  endpoints_allowed: "The authorization, token and key endpoints are https on allowed addresses.",
};

/** The first {@link SsoNetError} in an error's cause chain (openid-client wraps fetch errors). */
function netErrorIn(error: unknown): SsoNetError | undefined {
  let e: unknown = error;
  for (let depth = 0; depth < 6 && e; depth++) {
    if (e instanceof SsoNetError) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The well-known URL for an issuer (OpenID Connect Discovery: appended to the issuer's path). */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
}

class Report {
  private readonly checks: DiscoveryCheck[] = [];
  constructor(private readonly issuer: string | null) {}
  pass(id: DiscoveryCheckId): void {
    this.checks.push({ id, ok: true, message: PASSED[id] });
  }
  fail(id: DiscoveryCheckId, failure: DiscoveryFailure, message: string): DiscoveryReport {
    this.checks.push({ id, ok: false, message });
    return { ok: false, issuer: this.issuer, checks: this.checks, failure, message };
  }
  done(): DiscoveryReport {
    return { ok: true, issuer: this.issuer, checks: this.checks };
  }
}

export async function validateDiscovery(
  net: SsoNet,
  target: DiscoveryTarget,
): Promise<DiscoveryReport> {
  return (await discoverProvider(net, target)).report;
}

/**
 * {@link validateDiscovery} plus the server metadata when every check passed: what the sign-in
 * flow (KOBE-628) builds its `openid-client` configuration from.
 */
export async function discoverProvider(
  net: SsoNet,
  target: DiscoveryTarget,
): Promise<{ readonly report: DiscoveryReport; readonly metadata?: oidc.ServerMetadata }> {
  return checkDiscovery(net, target);
}

async function checkDiscovery(
  net: SsoNet,
  target: DiscoveryTarget,
): Promise<{ report: DiscoveryReport; metadata?: oidc.ServerMetadata }> {
  const wrap = (report: DiscoveryReport) => ({ report });
  const pinned = issuerFor(target);
  if (!pinned.ok) return wrap(new Report(null).fail("tenant_pinned", pinned.code, pinned.message));
  const issuer = pinned.issuer;
  const report = new Report(issuer);
  report.pass("tenant_pinned");

  const wellKnown = discoveryUrl(issuer);
  try {
    await checkSsoUrl(net, wellKnown);
  } catch (error) {
    const code = netErrorIn(error)?.code ?? "invalid_url";
    return wrap(report.fail("address_allowed", code, NET_MESSAGES[code]));
  }
  report.pass("address_allowed");

  let meta: oidc.ServerMetadata;
  try {
    const config = await oidc.discovery(
      new URL(issuer),
      "kobe-discovery-check",
      undefined,
      undefined,
      {
        [oidc.customFetch]: guardedFetch(net),
        timeout: Math.ceil(net.timeoutMs / 1000),
        ...(net.policy.allowHttp ? { execute: [oidc.allowInsecureRequests] } : {}),
      },
    );
    meta = config.serverMetadata();
  } catch (error) {
    const netError = netErrorIn(error);
    if (netError) return wrap(report.fail("reachable", netError.code, NET_MESSAGES[netError.code]));
    const code = (error as { code?: unknown }).code;
    if (code === JSON_ATTRIBUTE_COMPARISON) {
      report.pass("reachable");
      return wrap(report.fail("issuer_match", "issuer_mismatch", MESSAGES.issuer_mismatch));
    }
    return wrap(
      report.fail("reachable", "not_discovery_document", MESSAGES.not_discovery_document),
    );
  }
  report.pass("reachable");

  // Exact equality: openid-client accepts any issuer from login.microsoftonline.com or b2clogin.com.
  if (meta.issuer !== issuer) {
    return wrap(report.fail("issuer_match", "issuer_mismatch", MESSAGES.issuer_mismatch));
  }
  report.pass("issuer_match");

  if (!(meta.response_types_supported ?? []).includes("code")) {
    return wrap(report.fail("code_flow", "no_code_flow", MESSAGES.no_code_flow));
  }
  report.pass("code_flow");

  const methods = meta.code_challenge_methods_supported;
  const s256 = methods === undefined ? target.kind === "entra" : methods.includes("S256");
  if (!s256) return wrap(report.fail("pkce_s256", "no_pkce_s256", MESSAGES.no_pkce_s256));
  report.pass("pkce_s256");

  const endpoints = [meta.authorization_endpoint, meta.token_endpoint, meta.jwks_uri];
  for (const endpoint of endpoints) {
    try {
      if (typeof endpoint !== "string") throw new SsoNetError("invalid_url");
      await checkSsoUrl(net, endpoint);
    } catch {
      return wrap(
        report.fail("endpoints_allowed", "endpoint_not_allowed", MESSAGES.endpoint_not_allowed),
      );
    }
  }
  report.pass("endpoints_allowed");
  return { report: report.done(), metadata: meta };
}
