// Gate 4 (KOBE-4) harness, client side, part 2 of 2 (KOBE-232): U7 (per-user OAuth connector
// grants, drift) and U8's Orbit half (export, the pre-publish eval gate), then the MODES of the
// whole Gate 4 client. Appended after e2e/gate4/client.mjs (see there).

// --- U7: per-user connector grants -----------------------------------------------------------------

/** The Owner registers the OAuth MCP server (or finds it), and the team admin enables it. */
async function u7Setup() {
  const owner = await ownerSession();
  const listed = await owner.call("GET", "/v1/site/connectors");
  let connector = (listed.json.connectors ?? []).find((x) => x.name === config.name);
  if (connector) {
    out("register", "reused");
  } else {
    const made = await owner.call("POST", "/v1/site/connectors", {
      name: config.name,
      url: config.url,
      authKind: "oauth",
    });
    out("register", statusOf(made));
    out("pin", made.json.pin ? `${made.json.pin.ok}:${made.json.pin.failure ?? "-"}` : "-");
    connector = made.json.connector;
  }
  out("connector_id", connector?.id ?? "-");
  if (!connector?.id) return;
  const admin = await signedInAs(config.admin);
  const enabled = await admin.call("PUT", `/v1/team/connectors/${connector.id}`, {
    exposure: "all",
  });
  out("team_enable", statusOf(enabled));
  const { mcpServerSegment } = await import("/app/node_modules/@kobe/protocol/dist/index.js");
  out("segment", mcpServerSegment(config.name));
  const tools = await owner.call("GET", `/v1/site/connectors/${connector.id}/tools`);
  out("tools", (tools.json.tools ?? []).map((t) => `${t.name}:${t.status}`).join(",") || "-");
}

/** Starts the user's OAuth connect; prints the authorization URL (the browser's next stop). */
async function u7Start() {
  const c = await signedInAs(config.user);
  const r = await c.call("POST", `/v1/connector-grants/${config.connectorId}/oauth/start`);
  out("start", statusOf(r));
  console.log(
    `authorization_url_b64=${Buffer.from(r.json.authorization_url ?? "").toString("base64")}`,
  );
  return { c, url: r.json.authorization_url };
}

/** Kobe's callback, with the user's session, from the URL the authorization server redirected to. */
async function finishCallback(c, callbackUrl) {
  const u = new URL(callbackUrl);
  const r = await c.raw("GET", `${u.pathname}${u.search}`, undefined, {}, { redirect: "manual" });
  const location = r.headers.get("location") ?? "";
  out(
    "callback",
    `${r.status}:${new URL(location || "http://x/").searchParams.get("connector_oauth") ?? "-"}`,
  );
  const grants = await c.call("GET", "/v1/connector-grants");
  const g = (grants.json.grants ?? []).find(
    (x) => (x.connector_id ?? x.connectorId) === config.connectorId,
  );
  out("grant", g ? `${g.kind}` : "none");
}

/** The fake authorization server consents at once: start, follow it, then Kobe's callback. */
async function u7Connect() {
  const { c, url } = await u7Start();
  if (!url) return;
  const res = await fetch(url, { redirect: "manual" });
  out("authorize", res.status);
  await finishCallback(c, res.headers.get("location") ?? "http://x/");
}

/** A real authorization server: the harness got the redirect from a person or a script. */
async function u7Callback() {
  const c = await signedInAs(config.user);
  await finishCallback(c, Buffer.from(config.callbackB64, "base64").toString("utf8"));
}

/** Whether the user has a grant (an interactive connect is awaited with this). */
async function u7Grant() {
  const c = await signedInAs(config.user);
  const grants = await c.call("GET", "/v1/connector-grants");
  const g = (grants.json.grants ?? []).find(
    (x) => (x.connector_id ?? x.connectorId) === config.connectorId,
  );
  out("grant", g ? `${g.kind}` : "none");
}

/**
 * The stored credentials of each user's grant, opened with the site's envelope key: what must
 * never be in a sandbox. Printed base64 for the harness's scan (never shown).
 */
async function u7Tokens() {
  const kdb = await import("/app/node_modules/@kobe/db/dist/index.js");
  const envelope = kdb.loadEnvelope(process.env, { info() {}, warn() {}, error() {} });
  const database = await db();
  let n = 0;
  try {
    for (const u of config.users) {
      const rows = await kdb.withTeam(database.db, u.teamId, (tx) =>
        tx.execute(kdb.sql`SELECT sealed FROM connector_grants
          WHERE team_id = ${u.teamId} AND user_id = ${u.userId} AND connector_id = ${config.connectorId}`),
      );
      for (const r of rows.rows) {
        const plain = envelope.openString(r.sealed, {
          teamId: u.teamId,
          kind: "connector_grant",
          recordId: `${u.userId}:${config.connectorId}`,
        });
        const bundle = JSON.parse(plain);
        for (const v of [bundle.access_token, bundle.refresh_token].filter(Boolean)) {
          console.log(`granttoken ${u.key} ${Buffer.from(v).toString("base64")}`);
          n += 1;
        }
      }
    }
  } finally {
    await database.close();
  }
  out("grant_tokens", n);
}

async function u7Revoke() {
  const c = await signedInAs(config.user);
  out("revoke", (await c.call("DELETE", `/v1/connector-grants/${config.connectorId}`)).status);
  await u7Grant();
}

/** The Owner's review of the connector's tools; with config.approve, re-approves the drifted ones. */
async function u7Review() {
  const owner = await ownerSession();
  const r = await owner.call("GET", `/v1/site/connectors/${config.connectorId}/tools`);
  const tools = r.json.tools ?? [];
  out("review", tools.map((t) => `${t.name}:${t.status}:${t.change ?? "-"}`).join(",") || "-");
  if (!config.approve) return;
  const drifted = tools.filter((t) => t.status === "drifted" && t.live?.sha256);
  const a = await owner.call("POST", `/v1/site/connectors/${config.connectorId}/tools/approve`, {
    tools: drifted.map((t) => ({ name: t.name, sha256: t.live.sha256 })),
  });
  out("reapprove", `${a.status}:${(a.json.approved ?? []).length}`);
}

// --- U8: Orbit export and the pre-publish eval gate ------------------------------------------------

/** A published version as Orbit YAML, checked against the captured Orbit schema. */
async function u8Export() {
  const c = await signedInAs(config.user);
  const r = await c.raw("GET", `/v1/agents/${config.agentId}/versions/${config.version}/orbit`);
  out("export", `${r.status}:${(r.headers.get("content-type") ?? "-").split(";")[0]}`);
  const { createRequire } = await import("node:module");
  const yaml = createRequire("/app/package.json")("yaml");
  const { orbitExperimentSchema } = await import("/app/dist/agents/orbit/orbit-schema.js");
  try {
    const doc = yaml.parse(r.text);
    const checked = orbitExperimentSchema.safeParse(doc);
    out(
      "orbit_schema",
      checked.success ? "valid" : JSON.stringify(checked.error.issues).slice(0, 300),
    );
    out("orbit_agent", doc?.setup?.agents?.[0]?.name ?? "-");
    out(
      "orbit_prompt",
      String(doc?.setup?.agents?.[0]?.system_prompt ?? "").includes(config.marker),
    );
  } catch (err) {
    out("orbit_schema", `unparsable:${String(err).slice(0, 200)}`);
  }
}

/** The team's gate on at a threshold; publish; wait for the eval; was the version published? */
async function u8Gate() {
  const admin = await signedInAs(config.admin);
  const set = await admin.call("PUT", "/v1/team/eval-settings", {
    enabled: true,
    maxAttackSuccessRate: config.threshold,
  });
  out("gate_on", set.status);
  try {
    const c = await signedInAs(config.user);
    const made = await c.call("POST", "/v1/agents", {
      scope: "team",
      frontmatter: config.frontmatter,
      prompt: config.prompt,
    });
    const id = made.json.agent?.id;
    out("agent", `${made.status}:${id ?? "-"}`);
    if (!id) return;
    const pub = await c.call("POST", `/v1/agents/${id}/publish`, undefined, { "if-match": "*" });
    out("publish", `${pub.status}:${pub.json.eval?.status ?? pub.json.code ?? "-"}`);
    let last = {};
    for (let i = 0; i < config.timeoutS / 5; i += 1) {
      const evals = await c.call("GET", `/v1/agents/${id}/evals`);
      last = (evals.json.evals ?? [])[0] ?? {};
      if (!evals.json.active && last.status) break;
      await later(5000);
    }
    out(
      "eval",
      `${last.status ?? "-"}:asr=${last.attackSuccessRate ?? "-"}:threshold=${last.threshold ?? "-"}`,
    );
    out("eval_error", String(last.error ?? "-").slice(0, 200));
    const versions = await c.call("GET", `/v1/agents/${id}/versions`);
    out("published_version", versions.json.currentVersion ?? "none");
  } finally {
    out("gate_off", (await admin.call("PUT", "/v1/team/eval-settings", { enabled: false })).status);
  }
}

/** The Orbit test model as a catalog entry the team enables (k3d: e2e/gate4.sh starts it). */
async function u8Model() {
  const owner = await ownerSession();
  const p = await owner.call("POST", "/v1/site/models/providers", {
    kind: "openai_compatible",
    id: "orbitfake",
    name: "Orbit test model",
    base_url: config.url,
    allow_private_network: true,
  });
  out("provider", p.status === 409 ? "exists" : statusOf(p));
  const m = await owner.call("POST", "/v1/site/models/catalog", {
    alias: config.alias,
    provider_id: "orbitfake",
    model: "fake-vulnerable",
  });
  out("catalog", m.status === 409 ? "exists" : statusOf(m));
  const admin = await signedInAs(config.admin);
  out(
    "team_model",
    (await admin.call("PUT", `/v1/team/models/${config.alias}`, { enabled: true })).status,
  );
  const database = await db();
  try {
    let state = "-";
    for (let i = 0; i < 60; i += 1) {
      const rows = await database.pool.query(
        "SELECT (synced_version >= desired_version) AS ok, last_error FROM model_gateway_state",
      );
      state = rows.rows[0] ? `${rows.rows[0].ok}:${rows.rows[0].last_error ?? "-"}` : "-";
      if (state === "true:-") break;
      await later(2000);
    }
    out("gateway", state);
  } finally {
    await database.close();
  }
}

const MODES = {
  fixtures,
  turn,
  agent,
  thread,
  role,
  "provider-keys": providerKeys,
  "u1-invite": u1Invite,
  "u1-account": u1Account,
  "u1-totp": u1Totp,
  "u2-memory": u2Memory,
  u5,
  u6,
  u11,
  u14,
  u15,
  "u7-setup": u7Setup,
  "u7-start": async () => {
    await u7Start();
  },
  "u7-connect": u7Connect,
  "u7-callback": u7Callback,
  "u7-grant": u7Grant,
  "u7-tokens": u7Tokens,
  "u7-revoke": u7Revoke,
  "u7-review": u7Review,
  "u8-export": u8Export,
  "u8-gate": u8Gate,
  "u8-model": u8Model,
  "gallery-agent": galleryAgent,
};

const runStep = MODES[config.mode];
if (!runStep) {
  console.error(`unknown mode ${config.mode}`);
  process.exit(2);
}
try {
  await runStep();
  setTimeout(() => process.exit(0), 200).unref();
} catch (err) {
  console.error(`gate4 ${config.mode} failed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
}
