// Gate 4, U16's backup half (KOBE-233), client side. e2e/gate4-restore.sh runs this inside a Kobe
// server pod (`node --input-type=module -e`) after the Gate 1-3 clients' helpers (everything above
// `const MODES` in e2e/gate1/client.mjs, e2e/gate2/client.mjs and e2e/gate3/client.mjs: config,
// client(), readEvents(), db(), userClient(), ownerClient(), signedInAs(), turn(), state(), ...).
// Every step prints `key=value` lines. It drives the product's API as the browser does; the
// database is read for evidence the API does not expose, and written only for one fixture the API
// cannot make without a live MCP server (an API-key connector, as e2e/gate2 does for its own).

/** The Owner adds the fake model provider and the `fast` catalog entry (docs/install.md, Models). */
async function models() {
  const owner = await ownerClient();
  const listed = await owner.call("GET", "/v1/site/models");
  if (JSON.stringify(listed.json).includes(`"alias":"${config.alias}"`)) {
    out("models", "present");
    return;
  }
  const provider = await owner.call("POST", "/v1/site/models/providers", {
    kind: "openai",
    name: "Gate 4 restore fake OpenAI",
    api_key: config.providerKey,
    base_url: config.llm,
    allow_private_network: true,
  });
  out("provider", code(provider));
  const providerId = provider.json.provider?.id ?? provider.json.id ?? "openai";
  const entry = await owner.call("POST", "/v1/site/models/catalog", {
    alias: config.alias,
    provider_id: providerId,
    model: "gpt-fake",
  });
  out("catalog", code(entry));
}

/** One message in a new thread; the wall-clock time (epoch ms) of the first assistant token. */
async function firstToken() {
  const c = await signedInAs(config.user);
  const made = await c.call("POST", "/v1/threads", { title: config.title });
  out("thread_status", code(made));
  const threadId = made.json.thread_id;
  out("thread", threadId ?? "-");
  if (!threadId) return;
  const sent = await c.call("POST", `/v1/threads/${threadId}/messages`, {
    content: config.content,
  });
  out("message", code(sent));
  const runId = sent.json.run_id;
  if (sent.status !== 201 || !runId) return;
  const events = [];
  let first;
  let terminal;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 600_000);
  try {
    const res = await c.stream(runId, { signal: controller.signal });
    out("stream", res.status);
    if (res.status === 200) {
      await readEvents(res, (e) => {
        events.push(e);
        if (e.type === "text.delta" && first === undefined) first = Date.now();
        if (TERMINAL.has(e.type)) {
          terminal = e;
          return true;
        }
        return false;
      });
    }
  } finally {
    clearTimeout(timer);
  }
  out("first_token_at", first ?? "-");
  reportEvents(events, terminal);
}

// --- connector grant: sealed with the site's envelope key -----------------------------------------

/** An API-key connector enabled for the team (as e2e/gate2's fixture), then the member's own key. */
async function connector() {
  const database = await db();
  const { withTeam, sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
  const t = config.user.teamId;
  try {
    await database.pool.query(
      `INSERT INTO connectors (id, name, url, auth_kind, tools_snapshot)
         VALUES ($1, $2, $3, 'api_key', '[]'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [config.connectorId, config.name, config.url],
    );
    await withTeam(database.db, t, (tx) =>
      tx.execute(sql`
        INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by)
        VALUES (${t}, ${config.connectorId}, 'all', ${config.user.userId}) ON CONFLICT DO NOTHING`),
    );
  } finally {
    await database.close();
  }
  const c = await signedInAs(config.user);
  const r = await c.call("PUT", `/v1/connector-grants/${config.connectorId}`, {
    api_key: config.apiKey,
  });
  out("grant", code(r));
}

/** Opens the member's sealed grant with this install's envelope key, then with a wrong key. */
async function grantOpen() {
  const kdb = await import("/app/node_modules/@kobe/db/dist/index.js");
  const { randomBytes } = await import("node:crypto");
  const u = config.user;
  const database = await db();
  let sealed;
  try {
    const rows = await kdb.withTeam(database.db, u.teamId, (tx) =>
      tx.execute(kdb.sql`SELECT sealed FROM connector_grants
        WHERE team_id = ${u.teamId} AND user_id = ${u.userId} AND connector_id = ${config.connectorId}`),
    );
    sealed = rows.rows[0]?.sealed;
  } finally {
    await database.close();
  }
  out("grant_row", sealed ? "present" : "missing");
  if (!sealed) return;
  const context = {
    teamId: u.teamId,
    kind: "connector_grant",
    recordId: `${u.userId}:${config.connectorId}`,
  };
  const open = (envelope) => {
    try {
      return envelope.openString(sealed, context);
    } catch {
      return undefined;
    }
  };
  const quiet = { info() {}, warn() {}, error() {} };
  const plain = open(kdb.loadEnvelope(process.env, quiet));
  out("grant_sha", plain === undefined ? "refused" : await sha256(plain));
  const wrong = kdb.loadEnvelope({ KOBE_ENVELOPE_KEY: randomBytes(32).toString("base64") }, quiet);
  out("wrong_key", open(wrong) === undefined ? "refused" : "opened");
}

// --- skills, projects, the audit chain, object references ----------------------------------------

/** The skill version's stored bundle (bytes from the object store) and its recorded hash. */
async function skillBundle() {
  const c = await signedInAs(config.user);
  // client().raw() decodes the body as text; keep a copy of the response for the zip's bytes.
  const realFetch = globalThis.fetch;
  let copy;
  globalThis.fetch = async (...args) => {
    const res = await realFetch(...args);
    copy = res.clone();
    return res;
  };
  let r;
  try {
    r = await c.raw("GET", `/v1/skills/${config.skillId}/versions/${config.version}/bundle`);
  } finally {
    globalThis.fetch = realFetch;
  }
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from(await copy.arrayBuffer());
  out("bundle", `${r.status}:${createHash("sha256").update(bytes).digest("hex")}`);
}

/** The project's files as a member lists them (path and size). */
async function projectFiles() {
  const c = await signedInAs(config.user);
  const r = await c.call("GET", `/v1/projects/${config.projectId}/files`);
  out(
    "project_files",
    `${r.status}:${
      (r.json.files ?? [])
        .map((f) => `${f.path}:${f.size_bytes ?? f.size ?? "?"}`)
        .sort()
        .join(",") || "-"
    }`,
  );
}

/** The Owner's audit chain check (GET /v1/site/audit/integrity): ok, rows, head. */
async function integrity() {
  const owner = await ownerClient();
  const r = await owner.call("GET", "/v1/site/audit/integrity");
  out("integrity", `${r.status}:ok=${r.json.ok ?? "-"}:checked=${r.json.checked ?? "-"}`);
  out("problem", r.json.problem ? `${r.json.problem.seq}:${r.json.problem.kind}` : "-");
  out("head", r.json.head ? `${r.json.head.seq}:${r.json.head.hash}` : "-");
}

/**
 * Every object key the database references (BLOB_REF_COLUMNS, plus the skill bundles' storage
 * keys), per team, and whether the object store holds it: `blob <table.column>=<keys>:<missing>`.
 */
async function blobRefs() {
  const kdb = await import("/app/node_modules/@kobe/db/dist/index.js");
  const { loadS3Settings, createS3ObjectStore } = await import("/app/dist/workspace-sync/index.js");
  const settings = loadS3Settings(process.env);
  if (!settings) {
    out("blob_store", "none");
    return;
  }
  const store = createS3ObjectStore(settings);
  const columns = [
    ...kdb.BLOB_REF_COLUMNS,
    { table: "team_skill_versions", column: "storage_key" },
  ];
  const database = await db();
  const missing = [];
  try {
    const teams = (await database.pool.query("SELECT id FROM teams")).rows.map((r) => r.id);
    for (const { table, column, site } of columns) {
      let keys = 0;
      let gone = 0;
      // Team tables per team (RLS); site-wide ones (no team_id: personal and catalog skills) once.
      const reads = site
        ? [
            () =>
              database.db.execute(
                kdb.sql.raw(
                  `SELECT DISTINCT ${column} AS k FROM ${table} WHERE ${column} IS NOT NULL`,
                ),
              ),
          ]
        : teams.map(
            (teamId) => () =>
              kdb.withTeam(database.db, teamId, (tx) =>
                tx.execute(
                  kdb.sql.raw(
                    `SELECT DISTINCT ${column} AS k FROM ${table} WHERE team_id = '${teamId}' AND ${column} IS NOT NULL`,
                  ),
                ),
              ),
          );
      for (const read of reads) {
        const rows = await read();
        for (const { k } of rows.rows) {
          keys += 1;
          const got = await store.get(k);
          if (got) got.body.destroy();
          else {
            gone += 1;
            missing.push(`${table}.${column}:${k}`);
          }
        }
      }
      out(`blob ${table}.${column}`, `${keys}:${gone}`);
    }
  } finally {
    await database.close();
  }
  out("blob_missing", missing.slice(0, 5).join(" ") || "-");
}

const MODES = {
  fixtures,
  turn,
  thread,
  state,
  upload,
  "memory-settings": memorySettings,
  "memory-doc": memoryDoc,
  "project-setup": projectSetup,
  "skill-upload": skillUpload,
  models,
  "first-token": firstToken,
  connector,
  "grant-open": grantOpen,
  "skill-bundle": skillBundle,
  "project-files": projectFiles,
  integrity,
  "blob-refs": blobRefs,
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
  console.error(`restore ${config.mode} failed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
}
