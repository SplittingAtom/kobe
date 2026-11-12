// A mock Microsoft Entra ID (v2.0 endpoints) for the single sign-on gate (KOBE-633, spec
// docs/specs/sso-oidc-scim.md §17 SSO-9). It answers as `https://login.microsoftonline.com`: the
// gate points that name at this pod with a CoreDNS rewrite and gives the server its CA through the
// chart's `server.extraCaBundle`, so Kobe's own discovery, JWKS and token calls run unchanged, with
// no internet and no bypass in Kobe.
//
// Endpoints, per tenant (any id in `tenants`):
//   GET  /<tid>/v2.0/.well-known/openid-configuration   Entra's document shape (no PKCE methods listed)
//   GET  /<tid>/discovery/v2.0/keys                      JWKS (RS256, kid = x5t like Entra)
//   GET  /<tid>/oauth2/v2.0/authorize                    the browser step; answers with a redirect
//   POST /<tid>/oauth2/v2.0/token                        client secret (basic or post), single-use code, PKCE S256
//   GET  /_mock/stats                                    request counts per endpoint (for the gate)
//
// The browser step takes the person and the scenario from two test-only query parameters the gate
// appends to the authorize URL Kobe sent: `mock_user` (base64url JSON: oid, upn, name, roles,
// groups, mfa, amr, email, xms_edov, any extra claims) and `mock_mode`. Entra-like claims: `oid`,
// `tid`, a pairwise `sub` unlike `oid`, `ver: "2.0"`, `preferred_username`, `roles` or `groups`,
// a groups overage (`_claim_names`/`_claim_sources`, more than 200 groups or mode `overage`), and
// `acrs`: only when Kobe's `claims` parameter asks for an authentication context and the person
// passes MFA (`mfa: true`), as Conditional Access would.
//
// Bad-token modes (`mock_mode`): wrong_iss, wrong_aud, wrong_nonce, expired, stale_auth_time,
// alg_none, hs256 (keyed with the client secret), foreign_key, missing_tid, wrong_tid, overage,
// deny (the IdP answers the callback with access_denied).
//
// Run: node e2e/sso/mock-entra.mjs with MOCK_TENANTS (comma-separated GUIDs), MOCK_CLIENT_ID,
// MOCK_CLIENT_SECRET, MOCK_TLS_CERT and MOCK_TLS_KEY (PEM file paths), PORT (default 8443). `jose`
// is the server image's own copy (openid-client's dependency): no new package or image.
//
// As a generic OIDC provider (gate1 browser spec, KOBE-634; e2e/sso/gate1-mock-idp.yaml): set
// MOCK_ORIGIN to the mock's own https origin (its issuer is then `<origin>/<tid>/v2.0`, so the real
// login.microsoftonline.com is never touched), MOCK_ADVERTISE_PKCE=1 (Kobe's generic preset
// requires S256 in the document) and MOCK_HTTP_PORT for a plain-HTTP listener behind the ingress
// that serves the browser's authorize step only.

import { createHash, randomBytes, randomUUID } from "node:crypto";

export const ENTRA_ORIGIN = "https://login.microsoftonline.com";
export const MODES = [
  "ok",
  "wrong_iss",
  "wrong_aud",
  "wrong_nonce",
  "expired",
  "stale_auth_time",
  "alg_none",
  "hs256",
  "foreign_key",
  "missing_tid",
  "wrong_tid",
  "overage",
  "deny",
];
/** Entra puts at most 200 groups in a JWT; more is an overage. */
export const GROUPS_LIMIT = 200;
const CODE_TTL_MS = 10 * 60_000;
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000ff";

const b64u = (v) => Buffer.from(v).toString("base64url");
const json = (status, body, extra = {}) => ({
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  },
  body: JSON.stringify(body),
});
/** Entra's error body (AADSTS codes) for the token endpoint. */
const aadError = (status, error, code, text) =>
  json(status, {
    error,
    error_description: `AADSTS${code}: ${text}`,
    error_codes: [code],
    timestamp: new Date().toISOString(),
    trace_id: randomUUID(),
    correlation_id: randomUUID(),
  });

/** Decodes the `mock_user` parameter; an absent one is a default member with no access values. */
export function decodeUser(raw) {
  if (!raw) return { oid: randomUUID(), upn: "someone@mock.test", name: "Someone" };
  return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
}
export const encodeUser = (user) => b64u(JSON.stringify(user));

/** The authentication context ids Kobe's `claims` parameter asks for (`acrs` essential). */
export function requestedAcrs(claimsParam) {
  if (!claimsParam) return [];
  try {
    const acrs = JSON.parse(claimsParam)?.id_token?.acrs;
    if (!acrs) return [];
    if (typeof acrs.value === "string") return [acrs.value];
    return Array.isArray(acrs.values) ? acrs.values.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Creates the mock. `jose` is passed in (tests use their package's copy, the pod the server
 * image's). Returns `handle(request)` → `{status, headers, body}`, framework-free, plus `stats`.
 */
export async function createMockEntra({
  jose,
  tenants,
  clientId,
  clientSecret,
  origin = ENTRA_ORIGIN,
  advertisePkce = false,
  now = () => Date.now(),
}) {
  if (!jose) throw new Error("jose is required");
  if (!tenants?.length || !clientId || !clientSecret)
    throw new Error("tenants, clientId and clientSecret are required");
  const tenantSet = new Set(tenants.map((t) => t.toLowerCase()));
  const key = await jose.generateKeyPair("RS256", { extractable: true });
  const foreign = await jose.generateKeyPair("RS256");
  const kid = createHash("sha1").update(randomBytes(16)).digest("base64url");
  const jwk = { ...(await jose.exportJWK(key.publicKey)), kid, x5t: kid, use: "sig", alg: "RS256" };
  const codes = new Map();
  const stats = {
    discovery: 0,
    keys: 0,
    authorize: 0,
    token: 0,
    token_ok: 0,
    token_refused: 0,
    not_found: 0,
  };
  const issuerOf = (tid) => `${origin}/${tid}/v2.0`;

  function discovery(tid) {
    const base = `${origin}/${tid}`;
    // Entra's v2.0 document; like Entra it lists no code_challenge_methods_supported.
    return {
      token_endpoint: `${base}/oauth2/v2.0/token`,
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "private_key_jwt",
        "client_secret_basic",
      ],
      jwks_uri: `${base}/discovery/v2.0/keys`,
      response_modes_supported: ["query", "fragment", "form_post"],
      subject_types_supported: ["pairwise"],
      id_token_signing_alg_values_supported: ["RS256"],
      response_types_supported: ["code", "id_token", "code id_token", "id_token token"],
      ...(advertisePkce ? { code_challenge_methods_supported: ["S256"] } : {}),
      scopes_supported: ["openid", "profile", "email", "offline_access"],
      issuer: issuerOf(tid),
      request_uri_parameter_supported: false,
      userinfo_endpoint: "https://graph.microsoft.com/oidc/userinfo",
      authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
      device_authorization_endpoint: `${base}/oauth2/v2.0/devicecode`,
      http_logout_supported: true,
      frontchannel_logout_supported: true,
      end_session_endpoint: `${base}/oauth2/v2.0/logout`,
      claims_supported: [
        "sub",
        "iss",
        "cloud_instance_name",
        "aud",
        "exp",
        "iat",
        "auth_time",
        "acr",
        "nonce",
        "preferred_username",
        "name",
        "tid",
        "ver",
        "at_hash",
        "c_hash",
        "email",
      ],
      kerberos_endpoint: `${base}/kerberos`,
      tenant_region_scope: "EU",
      cloud_instance_name: "microsoftonline.com",
      cloud_graph_host_name: "graph.windows.net",
      msgraph_host: "graph.microsoft.com",
      rbac_url: "https://pas.windows.net",
    };
  }

  /** The person's claims as Entra would put them in a v2.0 ID token, then the mode's damage. */
  function claimsFor(grant) {
    const t = Math.floor(now() / 1000);
    const u = grant.user;
    const c = {
      aud: clientId,
      iss: issuerOf(grant.tid),
      iat: t,
      nbf: t,
      exp: t + 3600,
      auth_time: t,
      name: u.name ?? u.upn,
      nonce: grant.nonce,
      oid: u.oid,
      preferred_username: u.upn,
      rh: b64u(randomBytes(12)),
      sid: randomUUID(),
      // Pairwise per application: never the object id (Kobe keys on `oid`).
      sub: b64u(createHash("sha256").update(`${clientId}:${u.oid}`).digest()).slice(0, 43),
      tid: grant.tid,
      uti: b64u(randomBytes(16)),
      ver: "2.0",
    };
    if (u.upn) c.upn = u.upn;
    if (u.email) c.email = u.email;
    if (u.xms_edov !== undefined) c.xms_edov = u.xms_edov;
    if (u.roles) c.roles = u.roles;
    if (u.amr) c.amr = u.amr;
    if (grant.mode === "overage" || (u.groups?.length ?? 0) > GROUPS_LIMIT) {
      // Too many groups for a token: Entra names a Graph source instead of listing them.
      c._claim_names = { groups: "src1" };
      c._claim_sources = {
        src1: {
          endpoint: `https://graph.windows.net/${grant.tid}/users/${u.oid}/getMemberObjects`,
        },
      };
    } else if (u.groups) c.groups = u.groups;
    // Conditional Access: the requested authentication contexts are in `acrs` only when satisfied.
    if (u.mfa === true && grant.acrs.length > 0) c.acrs = grant.acrs;
    for (const [k, v] of Object.entries(u.extra ?? {})) c[k] = v;
    switch (grant.mode) {
      case "wrong_iss":
        c.iss = issuerOf(OTHER_TENANT);
        break;
      case "wrong_aud":
        c.aud = randomUUID();
        break;
      case "wrong_nonce":
        c.nonce = b64u(randomBytes(16));
        break;
      case "expired":
        Object.assign(c, { iat: t - 7200, nbf: t - 7200, auth_time: t - 7200, exp: t - 3600 });
        break;
      case "stale_auth_time":
        c.auth_time = t - 3600;
        break;
      case "missing_tid":
        delete c.tid;
        break;
      case "wrong_tid":
        c.tid = OTHER_TENANT;
        break;
      default:
        break;
    }
    return c;
  }

  async function idToken(grant) {
    const claims = claimsFor(grant);
    switch (grant.mode) {
      case "alg_none":
        return `${b64u(JSON.stringify({ typ: "JWT", alg: "none" }))}.${b64u(JSON.stringify(claims))}.`;
      case "hs256":
        return new jose.SignJWT(claims)
          .setProtectedHeader({ typ: "JWT", alg: "HS256", kid })
          .sign(new TextEncoder().encode(clientSecret));
      case "foreign_key":
        return new jose.SignJWT(claims)
          .setProtectedHeader({ typ: "JWT", alg: "RS256", kid })
          .sign(foreign.privateKey);
      default:
        return new jose.SignJWT(claims)
          .setProtectedHeader({ typ: "JWT", alg: "RS256", kid })
          .sign(key.privateKey);
    }
  }

  function authorize(tid, q) {
    stats.authorize++;
    const redirectUri = q.get("redirect_uri");
    if (q.get("client_id") !== clientId) {
      return json(400, {
        error: "unauthorized_client",
        error_description: "AADSTS700016: Application not found in the directory.",
      });
    }
    if (!redirectUri || !/^https?:\/\//.test(redirectUri)) {
      return json(400, {
        error: "invalid_request",
        error_description: "AADSTS50011: The redirect URI is not valid.",
      });
    }
    const back = new URL(redirectUri);
    const state = q.get("state");
    const fail = (error, text) => {
      back.searchParams.set("error", error);
      back.searchParams.set("error_description", text);
      if (state !== null) back.searchParams.set("state", state);
      return {
        status: 302,
        headers: { location: back.href, "cache-control": "no-store" },
        body: "",
      };
    };
    const mode = q.get("mock_mode") ?? "ok";
    if (!MODES.includes(mode))
      return json(400, {
        error: "invalid_request",
        error_description: `unknown mock_mode ${mode}`,
      });
    if (q.get("response_type") !== "code")
      return fail("unsupported_response_type", "AADSTS70005: response_type must be code.");
    if (!(q.get("scope") ?? "").split(" ").includes("openid"))
      return fail("invalid_scope", "AADSTS70011: openid is required.");
    if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
      return fail("invalid_request", "AADSTS9002325: Proof Key for Code Exchange is required.");
    }
    if (mode === "deny")
      return fail("access_denied", "AADSTS65004: User declined to consent to access the app.");
    let user;
    try {
      user = decodeUser(q.get("mock_user"));
    } catch {
      return json(400, {
        error: "invalid_request",
        error_description: "mock_user is not base64url JSON",
      });
    }
    const code = b64u(randomBytes(32));
    codes.set(code, {
      tid,
      user,
      mode,
      redirectUri,
      challenge: q.get("code_challenge"),
      nonce: q.get("nonce") ?? undefined,
      acrs: requestedAcrs(q.get("claims")),
      expires: now() + CODE_TTL_MS,
    });
    back.searchParams.set("code", code);
    if (state !== null) back.searchParams.set("state", state);
    back.searchParams.set("session_state", randomUUID());
    return { status: 302, headers: { location: back.href, "cache-control": "no-store" }, body: "" };
  }

  function clientOf(headers, form) {
    const auth = headers.authorization ?? headers.Authorization;
    if (typeof auth === "string" && auth.startsWith("Basic ")) {
      const [id, secret] = Buffer.from(auth.slice(6), "base64")
        .toString("utf8")
        .split(":")
        .map(decodeURIComponent);
      return { id, secret };
    }
    return { id: form.get("client_id"), secret: form.get("client_secret") };
  }

  async function token(tid, headers, body) {
    stats.token++;
    const form = new URLSearchParams(body ?? "");
    const refused = (...args) => {
      stats.token_refused++;
      return aadError(...args);
    };
    const client = clientOf(headers, form);
    if (client.id !== clientId)
      return refused(400, "unauthorized_client", 700016, "Application not found in the directory.");
    if (client.secret !== clientSecret)
      return refused(401, "invalid_client", 7000215, "Invalid client secret provided.");
    if (form.get("grant_type") !== "authorization_code")
      return refused(
        400,
        "unsupported_grant_type",
        70003,
        "The app requested an unsupported grant type.",
      );
    const code = form.get("code") ?? "";
    const grant = codes.get(code);
    codes.delete(code); // single use, whatever happens next
    if (!grant || grant.expires < now() || grant.tid !== tid) {
      return refused(
        400,
        "invalid_grant",
        70008,
        "The provided authorization code or refresh token has expired or was already used.",
      );
    }
    if (grant.redirectUri !== form.get("redirect_uri")) {
      return refused(
        400,
        "invalid_grant",
        50011,
        "The redirect URI does not match the one in the authorization request.",
      );
    }
    const challenge = createHash("sha256")
      .update(form.get("code_verifier") ?? "")
      .digest("base64url");
    if (challenge !== grant.challenge)
      return refused(
        400,
        "invalid_grant",
        501481,
        "The Code_Verifier does not match the code_challenge.",
      );
    stats.token_ok++;
    return json(200, {
      token_type: "Bearer",
      scope: "openid profile email",
      expires_in: 3599,
      ext_expires_in: 3599,
      access_token: b64u(randomBytes(48)),
      id_token: await idToken(grant),
    });
  }

  /** One request: `{method, path (with query), headers, body}` → `{status, headers, body}`. */
  async function handle({ method, path, headers = {}, body }) {
    const url = new URL(path, origin);
    if (url.pathname === "/_mock/stats") return json(200, stats);
    const m = /^\/([0-9a-fA-F-]{36})(\/.*)$/.exec(url.pathname);
    const tid = m?.[1].toLowerCase();
    if (!m || !tenantSet.has(tid)) {
      stats.not_found++;
      return json(400, {
        error: "invalid_tenant",
        error_description: "AADSTS90002: Tenant not found.",
      });
    }
    const rest = m[2];
    if (method === "GET" && rest === "/v2.0/.well-known/openid-configuration") {
      stats.discovery++;
      return json(200, discovery(tid), { "cache-control": "max-age=86400, private" });
    }
    if (method === "GET" && rest === "/discovery/v2.0/keys") {
      stats.keys++;
      return json(200, { keys: [{ ...jwk, issuer: issuerOf(tid) }] });
    }
    if (method === "GET" && rest === "/oauth2/v2.0/authorize")
      return authorize(tid, url.searchParams);
    if (method === "POST" && rest === "/oauth2/v2.0/token") return token(tid, headers, body);
    stats.not_found++;
    return json(404, { error: "not_found" });
  }

  return { handle, stats, kid, issuerOf, publicJwk: jwk };
}

/**
 * Whether a request may use the plain-HTTP listener: the browser's authorize step only (the
 * ingress in front of it), never the token endpoint, the keys or the stats.
 */
export function browserPath(method, path) {
  const pathname = path.split("?")[0];
  return method === "GET" && /^\/[0-9a-fA-F-]{36}\/oauth2\/v2\.0\/authorize$/.test(pathname);
}

/** Finds `jose`: this directory's resolution first, else the server image's pnpm store. */
async function loadJose() {
  try {
    return await import("jose");
  } catch {
    const { createRequire } = await import("node:module");
    const { pathToFileURL } = await import("node:url");
    const from = process.env.MOCK_JOSE_FROM ?? "/app/node_modules/.pnpm/node_modules/";
    const resolved = createRequire(from.endsWith("/") ? from : `${from}/`).resolve("jose");
    return import(pathToFileURL(resolved).href);
  }
}

async function main() {
  const { readFileSync } = await import("node:fs");
  const https = await import("node:https");
  const http = await import("node:http");
  const env = process.env;
  const mock = await createMockEntra({
    jose: await loadJose(),
    tenants: (env.MOCK_TENANTS ?? "").split(",").filter(Boolean),
    clientId: env.MOCK_CLIENT_ID,
    clientSecret: env.MOCK_CLIENT_SECRET,
    ...(env.MOCK_ORIGIN ? { origin: env.MOCK_ORIGIN.replace(/\/$/, "") } : {}),
    advertisePkce: env.MOCK_ADVERTISE_PKCE === "1",
  });
  const serve = (onlyBrowser) => (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out;
      try {
        out =
          onlyBrowser && !browserPath(req.method, req.url)
            ? json(404, { error: "not_found" })
            : await mock.handle({
                method: req.method,
                path: req.url,
                headers: req.headers,
                body: Buffer.concat(chunks).toString("utf8"),
              });
      } catch (err) {
        out = json(500, {
          error: "server_error",
          error_description: String(err?.message ?? err),
        });
      }
      // One line per request, never a query string, code or token.
      console.log(`REQ ${req.method} ${req.url.split("?")[0]} ${out.status}`);
      res.writeHead(out.status, out.headers).end(out.body);
    });
  };
  const port = Number(env.PORT ?? 8443);
  https
    .createServer(
      { cert: readFileSync(env.MOCK_TLS_CERT), key: readFileSync(env.MOCK_TLS_KEY) },
      serve(false),
    )
    .listen(port, () => console.log(`mock Entra on :${port}, kid ${mock.kid}`));
  if (env.MOCK_HTTP_PORT) {
    const httpPort = Number(env.MOCK_HTTP_PORT);
    http
      .createServer(serve(true))
      .listen(httpPort, () => console.log(`mock authorize (http) on :${httpPort}`));
  }
}

/** Run as a script (the ConfigMap mount is a symlink, so compare real paths). */
async function isMain() {
  if (!process.argv[1]) return false;
  const { realpathSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await isMain()) await main();
