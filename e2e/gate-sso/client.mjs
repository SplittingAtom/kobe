// The single sign-on gate (KOBE-633, spec docs/specs/sso-oidc-scim.md §17 SSO-9), client side.
// e2e/gate-sso.sh runs this inside a Kobe server pod (`node --input-type=module -e`) after the
// Gate 1 client's helpers (everything above `const MODES` in e2e/gate1/client.mjs: config, BASE,
// client(), db(), fixtures()) and e2e/sso/scim-client.mjs. It plays the browser of an SSO sign-in
// against the mock Entra (e2e/sso/mock-entra.mjs, reached as https://login.microsoftonline.com
// through the gate's CoreDNS rewrite and trusted through the chart's server.extraCaBundle) and
// Entra's provisioning service against Kobe's SCIM endpoints. Every step prints `key=value` lines;
// the database is read for evidence only (identities, session MFA records, user counts).

const PUBLIC = new URL(process.env.KOBE_PUBLIC_URL).origin;
const ENTRA = "https://login.microsoftonline.com";

/** A response's Set-Cookie pairs into a jar (name → value). */
function keepCookies(jar, res) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const at = pair.indexOf("=");
    const name = pair.slice(0, at);
    const value = pair.slice(at + 1);
    if (value === "" || /max-age=0/i.test(c)) jar.delete(name);
    else jar.set(name, value);
  }
}
const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const jarOut = (jar) => Buffer.from(JSON.stringify([...jar])).toString("base64url");
const jarIn = (raw) =>
  new Map(raw ? JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) : []);
/** A URL on the public origin (redirect URI, landing page) → the same path on the Service. */
const onService = (href) => {
  const u = new URL(href);
  return `${BASE}${u.pathname}${u.search}`;
};
const landedOf = (href) => {
  const u = new URL(href);
  return u.origin === PUBLIC ? `${u.pathname}${u.search}` : `elsewhere:${u.origin}`;
};

async function hop(url, jar, ip) {
  const res = await fetch(url, {
    redirect: "manual",
    headers: { cookie: cookieHeader(jar), "x-forwarded-for": ip, origin: PUBLIC },
  });
  keepCookies(jar, res);
  await res.text();
  return res;
}

/** The session behind a jar: GET /v1/me and /v1/me/teams. */
async function sessionOf(jar, ip) {
  const headers = { cookie: cookieHeader(jar), "x-forwarded-for": ip, origin: PUBLIC };
  const me = await fetch(`${BASE}/v1/me`, { headers });
  const meJson = me.status === 200 ? await me.json() : (await me.text(), {});
  let teams = "-";
  if (me.status === 200) {
    const t = await fetch(`${BASE}/v1/me/teams`, { headers });
    const tj = t.status === 200 ? await t.json() : { teams: [] };
    teams =
      (tj.teams ?? [])
        .map((x) => `${x.slug}:${x.role}`)
        .sort()
        .join(",") || "-";
  }
  return { status: me.status, user: meJson.user, teams };
}

/** The Better Auth session token in a jar (the cookie value before its signature). */
function sessionToken(jar) {
  for (const [name, value] of jar) {
    if (name.endsWith("session_token")) return decodeURIComponent(value).split(".")[0];
  }
  return null;
}

/**
 * One SSO sign-in as a browser does it: Kobe's start → the IdP's authorize (with the gate's
 * `mock_user` / `mock_mode`) → Kobe's callback → where Kobe sends the browser.
 */
async function ssoSignin() {
  const ip = config.ip;
  const jar = jarIn(config.jar);
  const start = await hop(
    `${BASE}/api/auth/sso/start/${config.slug}?returnTo=${encodeURIComponent(config.returnTo ?? "/")}`,
    jar,
    ip,
  );
  out("start", start.status);
  const authorize = new URL(start.headers.get("location") ?? "http://none/");
  out("authorize_host", authorize.host);
  out("claims_param", authorize.searchParams.get("claims") ?? "-");
  out("pkce", authorize.searchParams.get("code_challenge_method") ?? "-");
  if (authorize.origin !== ENTRA) return;
  authorize.searchParams.set(
    "mock_user",
    Buffer.from(JSON.stringify(config.user)).toString("base64url"),
  );
  if (config.mockMode) authorize.searchParams.set("mock_mode", config.mockMode);
  // The browser at the IdP: no Kobe cookies go there.
  const idp = await fetch(authorize, { redirect: "manual" });
  await idp.text();
  out("idp", idp.status);
  const back = idp.headers.get("location");
  if (!back) return;
  out("redirect_uri", new URL(back).origin === PUBLIC ? "public" : "elsewhere");
  const callback = await hop(onService(back), jar, ip);
  out("callback", callback.status);
  const landed = landedOf(callback.headers.get("location") ?? `${PUBLIC}/-`);
  out("landed", landed);
  out("sso_error", new URL(landed, PUBLIC).searchParams.get("sso_error") ?? "-");
  if (config.replay) {
    // The same callback again (a replayed or bookmarked URL): its state was spent.
    const again = await hop(onService(back), jar, ip);
    out("replay_landed", landedOf(again.headers.get("location") ?? `${PUBLIC}/-`));
  }
  const s = await sessionOf(jar, ip);
  out("session", s.status);
  out("user_id", s.user?.id ?? "-");
  out("teams", s.teams);
  const database = await db();
  try {
    const token = sessionToken(jar);
    const ctx = token
      ? await database.pool.query(
          `SELECT c.mfa_satisfied FROM sessions s JOIN session_sso_contexts c ON c.session_id = s.id
            WHERE s.token = $1`,
          [token],
        )
      : { rows: [] };
    out("sso_mfa", ctx.rows[0]?.mfa_satisfied ?? "-");
    const ident = await database.pool.query(
      `SELECT i.linked_via, i.user_id FROM sso_identities i JOIN sso_providers p ON p.id = i.provider_id
        WHERE p.slug = $1 AND i.subject = $2`,
      [config.slug, config.user.oid],
    );
    out("identity", ident.rows[0] ? `${ident.rows[0].linked_via}:${ident.rows[0].user_id}` : "-");
    const users = await database.pool.query(
      "SELECT count(*)::int AS n FROM users WHERE lower(email) = lower($1)",
      [config.user.upn],
    );
    out("users", users.rows[0].n);
  } finally {
    await database.close();
  }
  out("jar", jarOut(jar));
}

/** Whether a kept session still works. */
async function ssoSession() {
  const s = await sessionOf(jarIn(config.jar), config.ip);
  out("session", s.status);
}

async function ownerClient() {
  // A fresh address per step: Better Auth allows three sign-ins per address in 10 s.
  const owner = client(`198.51.100.${200 + Math.floor(Math.random() * 50)}`);
  const signed = await owner.signIn(config.owner.email, config.owner.password);
  if (signed.status !== 200) throw new Error(`owner sign-in: ${signed.status}`);
  return owner;
}

async function providerIds(owner) {
  const listed = await owner.call("GET", "/v1/site/sso/providers");
  return Object.fromEntries((listed.json.providers ?? []).map((p) => [p.slug, p]));
}

/** Providers listed, discovery tested, access mappings made (idempotent). */
async function ssoSetup() {
  const owner = await ownerClient();
  const providers = await providerIds(owner);
  const buttons = await owner.call("GET", "/api/auth/sso/providers");
  out(
    "buttons",
    (buttons.json.providers ?? [])
      .map((p) => p.slug)
      .sort()
      .join(",") || "-",
  );
  for (const slug of config.slugs) {
    const p = providers[slug];
    out(`provider_${slug}`, p ? `${p.kind}:${p.managedBy}` : "-");
    if (!p) continue;
    const test = await owner.call("POST", `/v1/site/sso/providers/${p.id}/test`);
    const failed = (test.json.discovery?.checks ?? []).filter((c) => !c.ok).map((c) => c.id);
    out(
      `discovery_${slug}`,
      test.json.discovery?.ok
        ? "ok"
        : `${test.status}:${failed.join(",") || test.json.discovery?.failure || "-"}`,
    );
  }
  for (const m of config.mappings) {
    const p = providers[m.slug];
    if (!p) continue;
    const made = await owner.call("POST", `/v1/site/sso/providers/${p.id}/mappings`, {
      claimValue: m.value,
      teamId: config.teamId,
      role: m.role,
    });
    out(`mapping_${m.slug}_${m.role}`, made.status === 409 ? "exists" : made.status);
  }
}

/** A SCIM token for a provider; earlier live tokens are revoked first (at most two live). */
async function scimToken() {
  const owner = await ownerClient();
  const p = (await providerIds(owner))[config.slug];
  const listed = await owner.call("GET", `/v1/site/sso/providers/${p.id}/scim`);
  for (const t of listed.json.tokens ?? []) {
    if (!t.revokedAt)
      await owner.call("POST", `/v1/site/sso/providers/${p.id}/scim/tokens/${t.id}/revoke`);
  }
  const made = await owner.call("POST", `/v1/site/sso/providers/${p.id}/scim/tokens`);
  out("scim_token_status", made.status);
  out("scim_base", made.json.baseUrl ? new URL(made.json.baseUrl).pathname : "-");
  out("scim_token_id", made.json.credential?.id ?? "-");
  out("scim_token", made.json.token ?? "-");
}

async function scimRevoke() {
  const owner = await ownerClient();
  const p = (await providerIds(owner))[config.slug];
  const r = await owner.call(
    "POST",
    `/v1/site/sso/providers/${p.id}/scim/tokens/${config.tokenId}/revoke`,
  );
  out("revoke", r.status);
}

/** Entra's provisioning requests against Kobe (e2e/sso/scim-client.mjs). */
async function scimStep() {
  const scim = scimClient({
    base: `${BASE}/v1/scim/v2/${config.slug}`,
    token: config.token,
    headers: { "x-forwarded-for": "198.51.100.252" },
  });
  const u = config.scimUser;
  const show = (key, r) =>
    out(key, `${r.status}${r.json?.active === undefined ? "" : `:active=${r.json.active}`}`);
  switch (config.action) {
    case "provision": {
      const p = await provisionUser(scim, u);
      for (const s of p.steps) console.log(s);
      out("scim_id", p.id ?? "-");
      const dup = await entra.create(scim, u);
      out("duplicate", `${dup.status}:${dup.json?.scimType ?? "-"}`);
      break;
    }
    case "update": {
      const r = await entra.updateAttributes(scim, config.id, {
        name: u.newName,
        givenName: u.newName.split(" ")[0],
        email: u.userName,
        familyName: u.newName.split(" ").slice(1).join(" "),
      });
      show("update", r);
      out("display_name", r.json?.displayName ?? "-");
      break;
    }
    case "deactivate":
      show("deactivate", await entra.deactivate(scim, config.id));
      break;
    case "reactivate":
      show("reactivate", await entra.reactivate(scim, config.id));
      break;
    case "delete":
      show("delete", await entra.remove(scim, config.id));
      show("get_after_delete", await entra.get(scim, config.id));
      break;
    case "probe":
      show("probe", await entra.probe(scim));
      break;
    default:
      throw new Error(`unknown SCIM action ${config.action}`);
  }
  out("scim_log", scim.log.join(", "));
}

/** The site's 2FA requirement through the Site console's API; off falls back to the database. */
async function require2fa() {
  const owner = await ownerClient();
  const r = await owner.call("PUT", "/v1/site/settings", { requireTwoFactor: config.on });
  out("require_2fa", r.status);
  if (r.status !== 200 && config.on === false) {
    // The test Owner has no TOTP, so with 2FA required its session may not change settings;
    // restoring the gate's own change is fixture work.
    const database = await db();
    try {
      await database.pool.query(
        "UPDATE site_settings SET value = 'false' WHERE key = 'require_2fa'",
      );
      out("require_2fa_restored", "db");
    } finally {
      await database.close();
    }
  }
}

/** What the server pod sees of the mock: the address the name resolves to, and the mock's counters. */
async function mockStats() {
  const { lookup } = await import("node:dns/promises");
  const a = await lookup("login.microsoftonline.com").catch((e) => ({
    address: `error:${e.code}`,
  }));
  out("resolved", a.address);
  try {
    const r = await fetch(`${ENTRA}/_mock/stats`);
    out("tls", "trusted");
    out("stats", JSON.stringify(await r.json()));
  } catch (err) {
    out("tls", err?.cause?.code ?? err?.code ?? "error");
  }
}

const MODES = {
  fixtures,
  "sso-setup": ssoSetup,
  "sso-signin": ssoSignin,
  "sso-session": ssoSession,
  "scim-token": scimToken,
  "scim-revoke": scimRevoke,
  scim: scimStep,
  "require-2fa": require2fa,
  "mock-stats": mockStats,
};
const mode = MODES[config.mode];
if (!mode) {
  console.error(`unknown mode ${config.mode}`);
  process.exit(2);
}
try {
  await mode();
  setTimeout(() => process.exit(0), 200).unref();
} catch (err) {
  console.error(
    `gate-sso ${config.mode} failed: ${err instanceof Error ? err.stack : String(err)}`,
  );
  process.exit(1);
}
