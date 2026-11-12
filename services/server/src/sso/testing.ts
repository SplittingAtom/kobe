import type { RawResponse } from "../connectors/oauth/http.js";
import type { SsoNet } from "./net.js";

/**
 * A scripted identity provider for SSO tests (KOBE-626): answers the pinned requests SSO makes
 * from a URL → response table, so discovery runs through the real SSRF checks without a network.
 */
export class FakeIdp {
  readonly hits: string[] = [];
  private readonly routes = new Map<string, () => RawResponse>();

  /** Serves `doc` as the discovery document of `issuer` (with sensible defaults). */
  discovery(issuer: string, doc: Record<string, unknown> = {}): this {
    const base = issuer.replace(/\/$/, "");
    return this.json(`${base}/.well-known/openid-configuration`, {
      issuer,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      jwks_uri: `${base}/keys`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      ...doc,
    });
  }

  json(url: string, body: unknown, status = 200): this {
    this.routes.set(url, () => ({
      status,
      headers: { "content-type": "application/json" },
      text: JSON.stringify(body),
    }));
    return this;
  }

  redirect(url: string, location: string): this {
    this.routes.set(url, () => ({ status: 302, headers: { location }, text: "" }));
    return this;
  }

  readonly request: NonNullable<SsoNet["request"]> = async (url) => {
    this.hits.push(url.href);
    const route = this.routes.get(url.href);
    if (!route) return { status: 404, headers: {}, text: "" };
    const res = route();
    if (res.status >= 300 && res.status < 400) {
      // As the real pinned request does: a redirect is refused, never followed.
      const { RedirectRefusedError } = await import("../connectors/oauth/http.js");
      throw new RedirectRefusedError();
    }
    return res;
  };
}

/** Public addresses for every name, unless `map` says otherwise. */
export function resolver(map: Record<string, string[]> = {}) {
  return async (host: string): Promise<string[]> => map[host] ?? ["93.184.216.34"];
}
