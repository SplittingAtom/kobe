// Gate 2 (KOBE-2, Safety) harness, client side. e2e/gate2.sh runs this inside a Kobe server pod
// (`node --input-type=module -e`) after the Gate 1 client's helpers: everything above `const MODES`
// in e2e/gate1/client.mjs (config, client(), readEvents(), signedIn(), db(), ...) is reused as is,
// then this file adds the Gate 2 steps and its own MODES. Every step prints `key=value` lines.
// Nothing here weakens a check: it drives the product's API, and touches the database only to
// read evidence or to set up fixtures the API cannot create (a plain-HTTP connector, a run lease).

const OWNER = config.owner ?? {};
const OWNER_IP = "198.51.100.251";

async function loginWithRetry(email, password, ip) {
  let c;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    c = client(ip);
    const res = await c.signIn(email, password);
    if (res.status === 200) return c;
    if (res.status !== 429) throw new Error(`sign-in ${email}: ${res.status} ${res.text}`);
    await sleep(11_000);
  }
  throw new Error(`sign-in ${email}: rate limited`);
}

const ownerClient = () => loginWithRetry(OWNER.email, OWNER.password, OWNER_IP);

async function userClient(user) {
  const c = await loginWithRetry(user.email, undefined, user.ip);
  if (user.teamId) await c.useTeam(user.teamId);
  return c;
}

/** Follows a run's event stream to its terminal event; returns what was seen. */
async function follow(c, runId, timeoutMs) {
  const events = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let terminal;
  try {
    const res = await c.stream(runId, { signal: controller.signal });
    if (res.status === 200) {
      await readEvents(res, (e) => {
        events.push(e);
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
  return { events, terminal };
}

// --- install-level setup ------------------------------------------------------------------

/** Makes a user an install admin (the second admin break-glass needs). */
async function grant() {
  const owner = await ownerClient();
  const res = await owner.call("PUT", `/v1/install/roles/${config.userId}`, { role: "admin" });
  out("role_status", res.status);
  const roles = await owner.call("GET", "/v1/install/roles");
  const privileged = (roles.json.roles ?? []).filter(
    (r) => r.role === "admin" || r.role === "owner",
  );
  out("install_admins", privileged.length);
}

/** Prices the catalog model only when it has no price (so a budget can be reached); restores. */
async function price() {
  const owner = await ownerClient();
  const listed = await owner.call("GET", "/v1/install/models");
  const entry = (listed.json.catalog ?? []).find((e) => e.alias === config.alias);
  if (!entry) {
    out("price", "no_such_model");
    return;
  }
  if (config.action === "restore") {
    const res = await owner.call("PATCH", `/v1/install/models/catalog/${config.alias}`, {
      input_usd_per_mtok: null,
      output_usd_per_mtok: null,
    });
    out("price", `restored:${res.status}`);
    return;
  }
  if (entry.input_usd_per_mtok != null || entry.output_usd_per_mtok != null) {
    out("price", "kept");
    return;
  }
  const res = await owner.call("PATCH", `/v1/install/models/catalog/${config.alias}`, {
    input_usd_per_mtok: 10_000,
    output_usd_per_mtok: 10_000,
  });
  out("price", `set:${res.status}`);
}

/** Puts a domain into the install's egress ceiling (or takes away what this harness added). */
async function ceiling() {
  const owner = await ownerClient();
  if (config.action === "remove") {
    const res = await owner.call("DELETE", `/v1/install/egress-ceiling/${config.domain}`);
    out("ceiling", `removed:${res.status}`);
    return;
  }
  const res = await owner.call("POST", "/v1/install/egress-ceiling", { domain: config.domain });
  if (res.status === 201) {
    out("ceiling", "added");
    return;
  }
  // Already there (an earlier run, or an admin's entry): make sure it is in the ceiling, keep it.
  const put = await owner.call("PUT", `/v1/install/egress-ceiling/${config.domain}`, {
    in_ceiling: true,
  });
  out("ceiling", `present:${res.status}:${put.status}`);
}

/** The team's own state for a scenario: no enablement of the domain, no tool rules, no budget. */
async function reset() {
  const admin = await userClient(config.admin);
  if (config.domain) {
    const res = await admin.call("DELETE", `/v1/team/egress/domains/${config.domain}`);
    out("domain_reset", res.status);
  }
  if (config.budget !== undefined) {
    const res = await admin.call("PUT", "/v1/team/budgets/team", { monthly_usd: config.budget });
    out("budget_status", res.status);
  }
}

// --- a chat run ---------------------------------------------------------------------------

/** One message on a (new or given) thread, followed to its end; optionally asks for access. */
async function run() {
  const c = await userClient(config.user);
  const threadId =
    config.threadId ?? (await c.call("POST", "/v1/threads", { title: "gate2" })).json.thread_id;
  out("thread", threadId);
  const sent = await c.call("POST", `/v1/threads/${threadId}/messages`, {
    content: config.content,
  });
  out("message", sent.status);
  if (sent.status !== 201 || !sent.json.run_id) {
    out("code", sent.json.code ?? "-");
    return;
  }
  const runId = sent.json.run_id;
  out("run", runId);
  const { events, terminal } = await follow(c, runId, config.timeoutMs ?? 300_000);
  const types = events.map((e) => e.type);
  out("terminal", terminal?.type ?? "none");
  out("types", [...new Set(types)].join(","));
  const index = (t) => types.indexOf(t);
  const toolDone = index("tool.result");
  out(
    "tool_result_before_terminal",
    Boolean(terminal) && toolDone >= 0 && toolDone < events.indexOf(terminal),
  );
  const blocked = events
    .filter((e) => e.type === "egress.blocked")
    .map((e) => `${e.data.payload?.domain}:${e.data.payload?.request_access}`);
  out("blocked", blocked.join(",") || "-");
  out(
    "text",
    events
      .filter((e) => e.type === "text.delta")
      .map((e) => e.data.payload?.delta ?? "")
      .join("")
      .replace(/\s+/g, " "),
  );
  out(
    "tool_output",
    events
      .filter((e) => e.type === "tool.result")
      .map((e) => JSON.stringify(e.data.payload ?? {}))
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 400),
  );
  out(
    "budget_message",
    events.find((e) => e.type === "run.budget_stopped")?.data.payload?.message ?? "-",
  );
  if (terminal?.type === "run.failed") {
    out("error", terminal.data.payload?.error?.code ?? "-");
  }
  if (config.ask) {
    const domain = (blocked[0] ?? "").split(":")[0] || config.domain;
    const req = await c.call("POST", "/v1/egress/requests", { domain, thread_id: threadId });
    out("request", `${req.status}:${req.json.request?.status ?? req.json.code}`);
    out("request_id", req.json.request?.id ?? "-");
  }
}

/** A new message while the budget is used up. */
async function send() {
  const c = await userClient(config.user);
  const threadId = (await c.call("POST", "/v1/threads", { title: "gate2 refused" })).json.thread_id;
  const sent = await c.call("POST", `/v1/threads/${threadId}/messages`, {
    content: config.content,
  });
  out("message", `${sent.status}:${sent.json.code ?? "-"}`);
}

/** The team admin's decision on an access request. */
async function decide() {
  const admin = await userClient(config.admin);
  const listed = await admin.call("GET", "/v1/team/egress/requests?status=pending");
  const seen = (listed.json.requests ?? []).find((r) => r.id === config.requestId);
  out("admin_sees_request", seen ? `thread=${seen.thread_id ?? "-"}` : "no");
  const res = await admin.call("POST", `/v1/team/egress/requests/${config.requestId}`, {
    decision: "approve",
  });
  out("decision", `${res.status}:${res.json.request?.status ?? res.json.code}`);
}

// --- evidence from the team's data and audit log --------------------------------------------

async function audit() {
  const admin = await userClient(config.admin);
  const res = await admin.call(
    "GET",
    `/v1/team/audit?action=${encodeURIComponent(config.action)}&limit=200`,
  );
  const since = config.since ? Date.parse(config.since) : 0;
  const events = (res.json.events ?? []).filter((e) => Date.parse(e.at) >= since);
  out("audit_status", res.status);
  out("audit_count", events.length);
  for (const e of events) {
    out(
      "audit_event",
      JSON.stringify({ seq: e.seq, actor: e.actor?.id, target: e.target }).slice(0, 700),
    );
  }
}

async function ledger() {
  const database = await db();
  const { withTeam, sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
  try {
    const rows = await withTeam(database.db, config.teamId, (tx) =>
      tx.execute(sql`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 200)::int AS ok
          FROM run_usage WHERE run_id = ${config.runId}`),
    );
    out("usage_rows", rows.rows[0].total);
    out("usage_ok_rows", rows.rows[0].ok);
  } finally {
    await database.close();
  }
}

/** Whether the user's sandbox opened a wire connection after `since`. */
async function wire() {
  const database = await db();
  const { withTeam, sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
  try {
    const rows = await withTeam(database.db, config.teamId, (tx) =>
      tx.execute(sql`
        SELECT count(*)::int AS n FROM sandbox_connections
         WHERE team_id = ${config.teamId} AND user_id = ${config.userId}
           AND closed_at IS NULL AND connected_at > ${config.since}::timestamptz`),
    );
    out("wire_open_since", rows.rows[0].n);
  } finally {
    await database.close();
  }
}

// --- MCP: fixtures and a signed approval --------------------------------------------------------

/** A connector (plain-HTTP fake server), enabled for the team, and a run leased to the sandbox. */
async function mcpFixture() {
  const database = await db();
  const { withTeam, sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
  const { randomUUID } = await import("node:crypto");
  const pinned = (name, annotations) => ({
    name,
    pi_name: `mcp__gate2_fake__${name}`,
    description: `${name} (pinned)`,
    input_schema: { type: "object" },
    annotations,
    sha256: "0".repeat(64),
    status: "pinned",
  });
  const snapshot = JSON.stringify([
    pinned("get_thing", { readOnlyHint: true }),
    pinned("create_thing", { destructiveHint: false }),
  ]);
  const threadId = randomUUID();
  const runId = randomUUID();
  const t = config.teamId;
  try {
    await database.pool.query(
      `INSERT INTO connectors (id, name, url, tools_snapshot) VALUES ($1, 'gate2-fake', $2, $3::jsonb)
         ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, tools_snapshot = EXCLUDED.tools_snapshot`,
      [config.connectorId, config.url, snapshot],
    );
    await withTeam(database.db, t, async (tx) => {
      await tx.execute(sql`
        INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by)
        VALUES (${t}, ${config.connectorId}, 'all', ${config.userId}) ON CONFLICT DO NOTHING`);
      await tx.execute(sql`
        INSERT INTO threads (team_id, id, owner_user_id, status)
        VALUES (${t}, ${threadId}, ${config.userId}, 'running')`);
      await tx.execute(sql`
        INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at)
        VALUES (${t}, ${runId}, ${threadId}, 'user', 'running', now())`);
      await tx.execute(sql`
        INSERT INTO sandbox_run_leases (team_id, run_id, user_id, thread_id, sandbox_id)
        VALUES (${t}, ${runId}, ${config.userId}, ${threadId}, ${config.sandboxId})`);
    });
    out("mcp_thread", threadId);
    out("mcp_run", runId);
  } finally {
    await database.close();
  }
}

/** Takes the fixture down again: the lease, the team's enablement and the connector. */
async function mcpClean() {
  const database = await db();
  const { withTeam, sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
  try {
    await withTeam(database.db, config.teamId, async (tx) => {
      await tx.execute(sql`DELETE FROM sandbox_run_leases WHERE run_id = ${config.runId}`);
      await tx.execute(sql`
        DELETE FROM team_connectors WHERE team_id = ${config.teamId} AND connector_id = ${config.connectorId}`);
    });
    await database.pool.query("DELETE FROM connectors WHERE id = $1", [config.connectorId]);
    out("mcp_clean", "done");
  } catch (err) {
    out("mcp_clean", `left_in_place:${err instanceof Error ? err.message.slice(0, 120) : "error"}`);
  } finally {
    await database.close();
  }
}

/** Session tokens signed with the install's keys, per audience (throwaway installs only). */
async function mint2() {
  const { signSessionToken } = await import("/app/dist/sandbox/session-token.js");
  const { sessionKeyEnvName } = await import("/app/dist/sandbox/config.js");
  const now = Math.floor(Date.now() / 1000);
  for (const aud of config.audiences) {
    const token = signSessionToken(
      {
        iss: "kobe-server",
        aud,
        sub: config.sandboxId,
        team_id: config.teamId,
        user_id: config.userId,
        iat: now,
        exp: now + 900,
        jti: `gate2-${now}-${Math.random().toString(36).slice(2)}`,
      },
      process.env[sessionKeyEnvName(aud)],
    );
    console.log(`token ${aud} ${token}`);
  }
}

/** The user's approval of one write, signed with the install key and stored as the server does. */
async function approve() {
  const { approvalKeyring } = await import("/app/dist/approvals/keys.js");
  const { signApproval } = await import("/app/node_modules/@kobe/protocol/dist/node/index.js");
  const { canonicalJson } = await import("/app/node_modules/@kobe/protocol/dist/index.js");
  const { randomUUID } = await import("node:crypto");
  const database = await db();
  const { withTeam, sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
  const approvalId = randomUUID();
  const t = config.teamId;
  const token = signApproval({
    key: approvalKeyring(process.env.KOBE_APPROVAL_KEY).current,
    approval_id: approvalId,
    team_id: t,
    run_id: config.runId,
    tool_call_id: config.toolCallId,
    tool: config.tool,
    input: config.input,
    now: new Date(),
  });
  try {
    await withTeam(database.db, t, (tx) =>
      tx.execute(sql`
        INSERT INTO approvals (team_id, id, run_id, thread_id, connection_id, user_id, tool_call_id, tool,
          input_canonical, risk, reasons, status, cause, decided_by, decided_at, expires_at,
          token_kid, token_expires_at, input_hmac)
        VALUES (${t}, ${approvalId}, ${config.runId}, ${config.threadId}, ${randomUUID()}, ${config.userId},
          ${config.toolCallId}, ${config.tool}, ${canonicalJson(config.input)}, 'write', '[]'::jsonb,
          'allowed', 'user', ${config.userId}, now(), now() + interval '1 hour',
          ${token.kid}, ${token.expires_at}, ${token.mac})`),
    );
    out("approval", "stored");
  } finally {
    await database.close();
  }
}

// --- break-glass -----------------------------------------------------------------------------------

/** The whole break-glass story through the API (spec D10), then the evidence on both sides. */
async function breakGlass() {
  const started = new Date(Date.now() - 2000).toISOString();
  const ia = await userClient({ ...config.requester, teamId: undefined });
  const owner = await ownerClient();
  const admin = await userClient(config.teamAdmin);
  const team = config.teamId;
  const asReader = (path) => ia.call("GET", path);

  const asked = await ia.call("POST", "/v1/install/break-glass", {
    teamId: team,
    reason: "Gate 2 verification: second-admin approval, notice and audit",
    durationMinutes: 15,
  });
  const id = asked.json.grant?.id;
  out("request", `${asked.status}:${asked.json.grant?.status ?? asked.json.code}`);
  out("grant", id ?? "-");
  if (!id) return;
  out("request_notified", asked.json.notified?.recipients ?? "-");
  const own = await ia.call("POST", `/v1/install/break-glass/${id}/approve`);
  out("self_approve", `${own.status}:${own.json.code ?? "-"}`);
  const early = await asReader(`/v1/install/break-glass/${id}/threads`);
  out("read_before_approval", `${early.status}:${early.json.code ?? "-"}`);

  const approved = await owner.call("POST", `/v1/install/break-glass/${id}/approve`);
  out("approve", `${approved.status}:${approved.json.grant?.status ?? approved.json.code}`);
  out("approve_self_approved", approved.json.grant?.selfApproved ?? "-");
  out("approve_team_admins_queued", approved.json.notified?.teamAdmins ?? "-");
  out("approve_warnings", (approved.json.warnings ?? []).map((w) => w.code).join(",") || "-");

  const database = await db();
  const { sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
  try {
    const rows = await database.db.execute(sql`
      SELECT recipient_role, event, status, count(*)::int AS n FROM break_glass_notifications
       WHERE grant_id = ${id} GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
    for (const r of rows.rows)
      out("notification", `${r.recipient_role}/${r.event}/${r.status}=${r.n}`);
  } finally {
    await database.close();
  }

  const banner = await admin.call("GET", "/v1/team/break-glass");
  const shown = (banner.json.active ?? []).find((g) => g.id === id);
  out(
    "team_banner",
    shown
      ? `active:requested_by=${shown.requestedBy?.name}:approved_by=${shown.approvedBy?.name}`
      : `missing:${banner.status}`,
  );

  const paths = [
    `/v1/install/break-glass/${id}/threads`,
    `/v1/install/break-glass/${id}/threads/${config.threadId}`,
    `/v1/install/break-glass/${id}/threads/${config.threadId}/entries`,
  ];
  const statuses = [];
  for (const p of paths) statuses.push((await asReader(p)).status);
  out("reads", statuses.join(","));
  ia.team = team;
  const normal = await ia.call("GET", `/v1/threads/${config.threadId}`);
  out("normal_route_with_grant", normal.status);
  ia.team = undefined;

  const seen = await admin.call(
    "GET",
    "/v1/team/audit?action=governance.break_glass.read&limit=200",
  );
  const mine = (seen.json.events ?? []).filter(
    (e) => Date.parse(e.at) >= Date.parse(started) && e.actor?.id === config.requester.userId,
  );
  out("audited_reads", mine.length);
  out(
    "audited_reads_have_target",
    mine.every((e) => JSON.stringify(e.target).includes(id)),
  );

  const revoked = await ia.call("POST", `/v1/install/break-glass/${id}/revoke`);
  out("revoke", `${revoked.status}:${revoked.json.grant?.status ?? revoked.json.code}`);
  const after = await asReader(paths[0]);
  out("read_after_revoke", `${after.status}:${after.json.code ?? "-"}`);
  for (const action of ["requested", "approved", "revoked"]) {
    const a = await admin.call(
      "GET",
      `/v1/team/audit?action=governance.break_glass.${action}&limit=200`,
    );
    const n = (a.json.events ?? []).filter((e) => Date.parse(e.at) >= Date.parse(started)).length;
    out(`team_audit_${action}`, n);
  }
}

/** The install's plaintext provider API keys, for the CI-side secret scan (never printed there). */
async function providerKeys() {
  const kdb = await import("/app/node_modules/@kobe/db/dist/index.js");
  const { SecretBox, PROVIDER_KEY_PURPOSE, providerKeyContext, modelProviders } = kdb;
  const secrets = [
    process.env.KOBE_MODELS_PROVIDER_KEY_SECRET,
    process.env.KOBE_MODELS_PROVIDER_KEY_SECRET_PREVIOUS,
  ].filter((v) => v);
  if (secrets.length === 0) {
    out("provider_keys", "gateway_not_configured");
    return;
  }
  const box = new SecretBox(secrets, PROVIDER_KEY_PURPOSE);
  const database = await db();
  try {
    const rows = await database.db.select().from(modelProviders);
    let n = 0;
    for (const p of rows) {
      if (p.apiKeyEnc === null) continue;
      const key = box.open(p.apiKeyEnc, providerKeyContext(p.id, p.keyRevision));
      console.log(`providerkey ${p.id} ${Buffer.from(key, "utf8").toString("base64")}`);
      n += 1;
    }
    out("provider_keys", n);
  } finally {
    await database.close();
  }
}

const MODES = {
  "provider-keys": providerKeys,
  fixtures,
  connections,
  grant,
  price,
  ceiling,
  reset,
  run,
  send,
  decide,
  audit,
  ledger,
  wire,
  "mcp-fixture": mcpFixture,
  "mcp-clean": mcpClean,
  mint2,
  approve,
  "break-glass": breakGlass,
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
  console.error(`gate2 ${config.mode} failed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
}
