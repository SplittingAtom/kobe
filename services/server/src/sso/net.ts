import { RedirectRefusedError, rawRequest } from "../connectors/oauth/http.js";
import { checkConnectorUrl, type ConnectorUrlPolicy } from "../connectors/url-policy.js";

/**
 * Outbound HTTP for single sign-on (spec sso-oidc-scim §11; KOBE-626): discovery, JWKS and the
 * token endpoint are called by the server pod itself, so every URL passes the connectors' SSRF
 * guard: https only (port 443 unless the chart allows more), every resolved address public
 * unless it is in `auth.sso.allowedInternalCidrs` (an on-premises IdP), the connection pinned to
 * the checked address (DNS rebinding), redirects never followed, time and size capped. A private
 * CA comes from `server.extraCaBundle` (`NODE_EXTRA_CA_CERTS`), which Node's TLS trusts as is.
 */
export interface SsoNet {
  readonly policy: ConnectorUrlPolicy;
  readonly timeoutMs: number;
  /** The pinned request (tests answer here instead of the network); default `rawRequest`. */
  readonly request?: typeof rawRequest;
}

export const SSO_TIMEOUT_MS = 10_000;

export type SsoNetFailure =
  | "https_required"
  | "address_not_allowed"
  | "host_unresolvable"
  | "port_not_allowed"
  | "invalid_url"
  | "redirect_refused"
  | "unreachable"
  | "too_large";

/** A refused or failed outbound call; the message never carries a URL, header or body. */
export class SsoNetError extends Error {
  constructor(readonly code: SsoNetFailure) {
    super(code);
    this.name = "SsoNetError";
  }
}

/** Checks one URL against the SSO address policy; throws {@link SsoNetError}. */
export async function checkSsoUrl(net: SsoNet, raw: string): Promise<URL> {
  const checked = await checkConnectorUrl(raw, net.policy);
  if (checked.ok) return new URL(checked.url);
  switch (checked.code) {
    case "https_required":
    case "address_not_allowed":
    case "host_unresolvable":
    case "port_not_allowed":
      throw new SsoNetError(checked.code);
    default:
      throw new SsoNetError("invalid_url");
  }
}

function headersOf(raw: Record<string, string | string[] | undefined>): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) out.append(k, one);
  }
  return out;
}

function bodyText(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new SsoNetError("invalid_url");
}

/**
 * A Fetch-compatible function for `openid-client` (`customFetch`) that sends every request through
 * the guard above. Throws {@link SsoNetError}; never follows a redirect.
 */
export function guardedFetch(net: SsoNet) {
  return async (
    url: string,
    options: { method: string; headers: Record<string, string>; body?: unknown },
  ): Promise<Response> => {
    const target = await checkSsoUrl(net, url);
    let res: Awaited<ReturnType<typeof rawRequest>>;
    try {
      const text = bodyText(options.body);
      res = await (net.request ?? rawRequest)(target, net, {
        method: options.method,
        headers: options.headers,
        ...(text === undefined ? {} : { body: text }),
      });
    } catch (error) {
      if (error instanceof SsoNetError) throw error;
      throw new SsoNetError(
        error instanceof RedirectRefusedError ? "redirect_refused" : "unreachable",
      );
    }
    if (res.text === undefined) throw new SsoNetError("too_large");
    if (res.status < 200 || res.status > 599) throw new SsoNetError("unreachable");
    return new Response(res.text, { status: res.status, headers: headersOf(res.headers) });
  };
}
