import { createHash, randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import type { RawResponse } from "../connectors/oauth/http.js";
import type { SsoNet } from "../sso/net.js";

/**
 * A tiny in-process OpenID Connect provider for tests (KOBE-628; SSO-9 builds the k3d one): a
 * discovery document, a JWKS, an authorization step driven by the test, and a token endpoint
 * that checks the client secret, the redirect URI, single-use codes and PKCE S256, then issues an
 * ID token signed with its own key (RS256 or ES256). It answers SSO's pinned requests
 * (`SsoNet.request`), so the server's SSRF guard still runs; no network is involved.
 *
 * Bad-token modes make the ID token `alg: none`, HS256 keyed with the client secret, or signed
 * by a key that is not in the JWKS; `overrides` replace any claim (wrong `aud`, `iss`, `tid`,
 * `nonce`, expired `exp`, a groups overage, ...). `down` makes every request fail like an
 * unreachable host.
 */

export type MockTokenMode = "ok" | "alg_none" | "hs256_client_secret" | "foreign_key";

export interface MockOidcOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Entra-like: adds `tid` to every token. */
  readonly tenantId?: string;
  readonly algorithm?: "RS256" | "ES256";
  /** Replaces fields of the discovery document. */
  readonly discovery?: Readonly<Record<string, unknown>>;
}

interface Grant {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly nonce: string | undefined;
  readonly claims: Readonly<Record<string, unknown>>;
}

const json = (body: unknown, status = 200): RawResponse => ({
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  text: JSON.stringify(body),
});
const b64u = (v: string | Buffer) => Buffer.from(v).toString("base64url");

export class MockOidcProvider {
  readonly hits: string[] = [];
  /** Every request fails like an unreachable host (break-glass tests). */
  down = false;
  mode: MockTokenMode = "ok";
  /** Claims set on every ID token after the defaults and the user's claims. */
  overrides: Record<string, unknown> = {};
  /** Adds RFC 9207 `iss` to the authorization response. */
  issParameter: string | undefined;
  private readonly codes = new Map<string, Grant>();
  private readonly base: string;

  private constructor(
    readonly options: MockOidcOptions,
    private readonly key: CryptoKey,
    private readonly foreignKey: CryptoKey,
    private readonly jwk: JWK,
    readonly kid: string,
  ) {
    this.base = options.issuer.replace(/\/$/, "");
  }

  static async create(options: MockOidcOptions): Promise<MockOidcProvider> {
    const alg = options.algorithm ?? "RS256";
    const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
    const foreign = await generateKeyPair(alg);
    const kid = randomBytes(8).toString("hex");
    const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
    return new MockOidcProvider(options, privateKey, foreign.privateKey, jwk, kid);
  }

  get issuer(): string {
    return this.options.issuer;
  }

  /** Whether `url` belongs to this provider (for {@link routeMockOidc}). */
  owns(url: URL): boolean {
    return url.href.startsWith(`${this.base}/`);
  }

  discoveryDocument(): Record<string, unknown> {
    return {
      issuer: this.options.issuer,
      authorization_endpoint: `${this.base}/authorize`,
      token_endpoint: `${this.base}/token`,
      jwks_uri: `${this.base}/keys`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: [this.options.algorithm ?? "RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      ...this.options.discovery,
    };
  }

  /**
   * The person signs in at the IdP: checks the authorization request Kobe sent and returns the
   * callback URL (redirect URI + `code` + `state`) the browser would be sent to.
   */
  authorize(authorizationUrl: string, user: Readonly<Record<string, unknown>>): URL {
    const req = new URL(authorizationUrl);
    if (!req.href.startsWith(`${this.base}/authorize`)) throw new Error("not this provider");
    const p = req.searchParams;
    if (p.get("client_id") !== this.options.clientId) throw new Error("unknown client_id");
    if (p.get("response_type") !== "code") throw new Error("response_type must be code");
    if (p.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 required");
    if (!(p.get("scope") ?? "").split(" ").includes("openid")) throw new Error("openid scope");
    const redirectUri = p.get("redirect_uri") ?? "";
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, {
      clientId: this.options.clientId,
      redirectUri,
      challenge: p.get("code_challenge") ?? "",
      nonce: p.get("nonce") ?? undefined,
      claims: user,
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    const state = p.get("state");
    if (state !== null) back.searchParams.set("state", state);
    if (this.issParameter !== undefined) back.searchParams.set("iss", this.issParameter);
    return back;
  }

  /** The IdP answers the callback with an error (the person cancelled, consent refused). */
  deny(authorizationUrl: string, error = "access_denied"): URL {
    const p = new URL(authorizationUrl).searchParams;
    const back = new URL(p.get("redirect_uri") ?? "");
    back.searchParams.set("error", error);
    const state = p.get("state");
    if (state !== null) back.searchParams.set("state", state);
    return back;
  }

  private clientAuthenticated(headers: Record<string, string>, body: URLSearchParams): boolean {
    const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === "authorization")?.[1];
    if (auth?.startsWith("Basic ")) {
      const [id, secret] = Buffer.from(auth.slice(6), "base64")
        .toString("utf8")
        .split(":")
        .map((s) => decodeURIComponent(s));
      return id === this.options.clientId && secret === this.options.clientSecret;
    }
    return (
      body.get("client_id") === this.options.clientId &&
      body.get("client_secret") === this.options.clientSecret
    );
  }

  private async idToken(grant: Grant): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const all: Record<string, unknown> = {
      iss: this.options.issuer,
      aud: grant.clientId,
      sub: grant.claims.sub ?? grant.claims.oid ?? "subject-1",
      iat: now,
      nbf: now,
      exp: now + 3600,
      ...(grant.nonce === undefined ? {} : { nonce: grant.nonce }),
      ...(this.options.tenantId === undefined ? {} : { tid: this.options.tenantId, ver: "2.0" }),
      ...grant.claims,
      ...this.overrides,
    };
    // An override of `undefined` removes the claim.
    const claims = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined));
    const alg = this.options.algorithm ?? "RS256";
    switch (this.mode) {
      case "alg_none":
        return `${b64u(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64u(JSON.stringify(claims))}.`;
      case "hs256_client_secret":
        return new SignJWT(claims)
          .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: this.kid })
          .sign(new TextEncoder().encode(this.options.clientSecret));
      case "foreign_key":
        return new SignJWT(claims)
          .setProtectedHeader({ alg, typ: "JWT", kid: this.kid })
          .sign(this.foreignKey);
      default:
        return new SignJWT(claims)
          .setProtectedHeader({ alg, typ: "JWT", kid: this.kid })
          .sign(this.key);
    }
  }

  private async token(init: { headers: Record<string, string>; body?: string }) {
    const body = new URLSearchParams(init.body ?? "");
    if (!this.clientAuthenticated(init.headers, body)) {
      return json({ error: "invalid_client" }, 401);
    }
    if (body.get("grant_type") !== "authorization_code") {
      return json({ error: "unsupported_grant_type" }, 400);
    }
    const code = body.get("code") ?? "";
    const grant = this.codes.get(code);
    this.codes.delete(code);
    const verifier = body.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (!grant || grant.redirectUri !== body.get("redirect_uri") || grant.challenge !== challenge) {
      return json({ error: "invalid_grant" }, 400);
    }
    return json({
      access_token: randomBytes(16).toString("hex"),
      token_type: "Bearer",
      expires_in: 3600,
      id_token: await this.idToken(grant),
    });
  }

  readonly request: NonNullable<SsoNet["request"]> = async (url, _io, init) => {
    this.hits.push(url.href);
    if (this.down) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    if (url.href === `${this.base}/.well-known/openid-configuration`) {
      return json(this.discoveryDocument());
    }
    if (url.href === `${this.base}/keys`) return json({ keys: [this.jwk] });
    if (url.href === `${this.base}/token` && init.method === "POST") return this.token(init);
    return { status: 404, headers: {}, text: "" };
  };
}

/** One `SsoNet.request` for several mock providers (each answers its own issuer's URLs). */
export function routeMockOidc(...providers: readonly MockOidcProvider[]) {
  const request: NonNullable<SsoNet["request"]> = async (url, io, init) => {
    const owner = providers.find((p) => p.owns(url));
    return owner ? owner.request(url, io, init) : { status: 404, headers: {}, text: "" };
  };
  return request;
}
