// The Kobe Explorer Gate (KOBE-441, MCP Apps spec §11) harness, client side: the checks the browser
// cannot make. e2e/gate-apps.sh runs this inside a Kobe server pod (`node --input-type=module -e`)
// after the Gate 1-3 clients' helpers (everything above `const MODES` in e2e/gate1/client.mjs,
// gate2 and gate3: config, client(), db(), userClient(), ownerClient(), signedInAs(), turn(),
// follow(), code(), ...). Every step prints `key=value` lines. It drives the product's API; the
// database is read for evidence only (what Pi sent, audit rows), and the internal listener is
// called only to show it refuses forged reports.

/** The app's connector registered, pinned (templates approved) and enabled; keys set. */
async function appsSetup() {
  const owner = await ownerClient();
  const admin = await signedInAs(config.admin);
  const registered = {};
  for (const c of config.connectors) {
    const listed = await owner.call("GET", "/v1/site/connectors");
    let found = (listed.json.connectors ?? []).find((x) => x.name === c.name);
    if (!found) {
      const made = await owner.call("POST", "/v1/site/connectors", {
        name: c.name,
        url: config.url,
        ...(c.authKind ? { authKind: c.authKind } : {}),
      });
      out(`register_${c.key}`, `${made.status}:${made.json.pin?.ok ?? made.json.code ?? "-"}`);
      found = made.json.connector;
    }
    if (!found) continue;
    registered[c.key] = found.id;
    const review = await owner.call("GET", `/v1/site/connectors/${found.id}/templates`);
    const pending = (review.json.templates ?? []).filter((t) => t.live && t.status !== "pinned");
    if (pending.length > 0) {
      const approved = await owner.call(
        "POST",
        `/v1/site/connectors/${found.id}/templates/approve`,
        {
          templates: pending.map((t) => ({ uri: t.uri, pinnedHash: t.live.pinnedHash })),
        },
      );
      out(`approve_${c.key}`, approved.status);
    }
    out(
      `templates_${c.key}`,
      (await owner.call("GET", `/v1/site/connectors/${found.id}/templates`)).json.templates
        ?.map((t) => `${t.uri}:${t.status}`)
        .join(",") ?? "-",
    );
    const enabled = await admin.call("PUT", `/v1/team/connectors/${found.id}`, { exposure: "all" });
    out(`enable_${c.key}`, enabled.status);
    if (c.authKind === "api_key" && c.adminKey) {
      out(
        `admin_key_${c.key}`,
        (await admin.call("PUT", `/v1/connector-grants/${found.id}`, { api_key: c.adminKey }))
          .status,
      );
    }
  }
  const apps = (await admin.call("GET", "/v1/team/apps")).json.apps ?? [];
  for (const [key, id] of Object.entries(registered)) {
    out(`connector_${key}`, id);
    out(`app_${key}`, apps.find((a) => a.connectorId === id)?.appId ?? "-");
  }
}

/** What a member's rail lists: their apps and the "Add your key" hints (MA8). */
async function appsMember() {
  const c = await signedInAs(config.user);
  const listed = (await c.call("GET", "/v1/team/apps")).json;
  out(
    "apps",
    (listed.apps ?? [])
      .map((a) => a.connectorName)
      .sort()
      .join(",") || "-",
  );
  out(
    "needs_key",
    (listed.needsKey ?? [])
      .map((a) => a.connectorName)
      .sort()
      .join(",") || "-",
  );
}

/** The thread's app results as config.user sees them, and what Pi sent for the run's calls. */
async function appsResults() {
  const c = await signedInAs(config.user);
  const res = await c.call("GET", `/v1/threads/${config.threadId}/app-results`);
  out("results_status", res.status);
  for (const r of res.json.results ?? []) {
    const kind = r.tool_call_id ? "tool" : r.entry_id ? "card" : "other";
    out("result", `${kind}:${r.view}:${r.reason ?? "-"}:${r.queued === true ? "queued" : "in"}`);
  }
  const database = await db();
  const { withTeam, sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
  try {
    const rows = await withTeam(database.db, config.user.teamId, (tx) =>
      tx.execute(sql`
        SELECT e.payload->>'tool' AS tool, e.payload->'input' AS input, e.payload->'app' AS app, e.type
          FROM run_events e JOIN runs r ON r.team_id = e.team_id AND r.id = e.run_id
         WHERE r.team_id = ${config.user.teamId} AND r.thread_id = ${config.threadId}
           AND e.type IN ('tool.call', 'tool.result') ORDER BY e.run_id, e.seq`),
    );
    for (const row of rows.rows) {
      if (row.type === "tool.call") out("pi_input", `${row.tool}:${JSON.stringify(row.input)}`);
      else out("app_marker", `${row.tool}:${row.app ? "yes" : "no"}`);
    }
  } finally {
    await database.close();
  }
}

/** One app call as config.user (the bridge's path, MA-4), and its audit rows. */
async function appsCall() {
  const c = await signedInAs(config.user);
  const res = await c.call("POST", `/v1/team/apps/${config.appId}/calls`, {
    tool: config.tool,
    arguments: config.args ?? {},
  });
  out("call", `${res.status}:${res.json.error?.code ?? "ok"}`);
  const database = await db();
  try {
    const rows = await database.pool.query(
      `SELECT target->>'tool' AS tool, target->>'decision' AS decision, target->>'reason' AS reason
         FROM audit_log WHERE team_id = $1 AND action = 'mcp.app_call' AND target->>'userId' = $2
        ORDER BY seq DESC LIMIT 1`,
      [config.user.teamId, config.user.userId],
    );
    const a = rows.rows[0];
    out("audit_last", a ? `${a.tool}:${a.decision}:${a.reason}` : "-");
  } finally {
    await database.close();
  }
}

/** A rail launch through the API: into config.threadId, or a new thread. */
async function appsLaunch() {
  const c = await signedInAs(config.user);
  const path = config.threadId
    ? `/v1/threads/${config.threadId}/app-cards`
    : "/v1/threads/app-cards";
  const res = await c.call("POST", path, { app_id: config.appId });
  out("launch", `${res.status}:${res.json.queued ?? res.json.code ?? "-"}`);
  out("thread", res.json.thread_id ?? "-");
  out("entry", res.json.entry_id ?? "-");
  if (res.json.thread_id) {
    const runs = await c.call("GET", `/v1/threads/${res.json.thread_id}/runs`);
    out("runs", (runs.json.runs ?? []).length);
  }
}

/** The thread's entries: app cards (and where the next prompt hangs), and fenced context. */
async function appsEntries() {
  const c = await signedInAs(config.user);
  const entries = [];
  let after;
  for (let page = 0; page < 50; page += 1) {
    const r = await c.call(
      "GET",
      `/v1/threads/${config.threadId}${after === undefined ? "" : `?after=${after}`}`,
    );
    entries.push(...(r.json.entries ?? []));
    if (r.status !== 200 || r.json.next_entries_after == null) break;
    after = r.json.next_entries_after;
  }
  const byId = new Map(entries.map((e) => [e.entry_id, e]));
  const cards = entries.filter((e) => e.payload?.customType === "kobe.app_card");
  out("cards", cards.length);
  for (const card of cards) {
    const text = String(card.payload?.content ?? "");
    out(
      "card",
      `${/^ka-/.test(card.entry_id)}:${text.includes('opened_by_member="true" untrusted="true"')}:${text.includes("e2e-structured-only")}`,
    );
    const below = entries.find((e) => e.parent_id === card.entry_id);
    out(
      "below_card",
      below ? (below.payload?.type === "message" ? below.payload.message?.role : below.type) : "-",
    );
  }
  const users = entries.filter((e) => e.payload?.message?.role === "user");
  out(
    "fenced_context",
    users.some((u) => JSON.stringify(u.payload.message.content).includes("<app-context source=")),
  );
  const seqOf = (id) => byId.get(id)?.seq ?? -1;
  if (cards[0] && users.length > 0) {
    out("card_before_last_prompt", seqOf(cards.at(-1).entry_id) < seqOf(users.at(-1).entry_id));
  }
}

/** Forged result reports at the server's internal listener (the sandbox never has its key). */
async function appsForged() {
  const port = process.env.KOBE_INTERNAL_PORT ?? "8082";
  const url = `http://127.0.0.1:${port}/internal/v1/mcp/connectors/${config.connectorId}/results`;
  const body = JSON.stringify({ ticket: "forged", input: {}, result: { content: [] } });
  const send = (headers) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    })
      .then((r) => r.status)
      .catch(() => "unreachable");
  out("forged_no_key", await send({}));
  out(
    "forged_token",
    await send({
      authorization: `Bearer ${process.env.KOBE_MCP_PROXY_INTERNAL_KEY ?? ""}`,
      "kobe-sandbox-token": "forged.sandbox.token",
    }),
  );
}

/** The fake server's template changes (a rug-pull); the connector is refreshed now. */
async function appsDrift() {
  out(
    "drift",
    (
      await fetch(`${config.fakeUrl}/_drift`)
        .then((r) => r.text())
        .catch((e) => String(e))
    ).trim(),
  );
  const { refreshConnector } = await import("/app/dist/connectors/refresh.js");
  const { createProxyProbe } = await import("/app/dist/connectors/probe.js");
  const prober = createProxyProbe({
    baseUrl: process.env.KOBE_MCP_PROXY_URL,
    internalKey: process.env.KOBE_MCP_PROXY_INTERNAL_KEY,
    timeoutMs: 30_000,
  });
  const database = await db();
  try {
    const outcome = await refreshConnector(database.db, prober, config.connectorId);
    out("refresh", outcome.status);
  } finally {
    await database.close();
  }
}

/** The author shares the thread with the team (the viewer then acts as themselves, T12). */
async function appsShare() {
  const c = await signedInAs(config.user);
  const res = await c.call("POST", `/v1/threads/${config.threadId}/share`, { visibility: "team" });
  out("share", res.status);
}

/** A signed-in session as plain fetch (for a binary answer the shared client reads as text). */
async function binarySession(user) {
  const jar = new Map();
  const ip = `198.51.103.${1 + Math.floor(Math.random() * 250)}`;
  const send = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-forwarded-for": ip,
        "x-kobe-team": user.teamId,
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return res;
  };
  await send("POST", "/api/auth/sign-in/email", { email: user.email, password: PASSWORD });
  await send("PUT", "/v1/me/teams/active", { teamId: user.teamId });
  return send;
}

/** The member's export: the thread's text only, never the structured result or the template. */
async function appsExport() {
  const send = await binarySession(config.user);
  const res = await send("GET", `/v1/threads/export?team=${config.user.teamId}`);
  out("export_status", res.status);
  if (res.status !== 200) return;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const { unzipSync, strFromU8 } = await import("/app/node_modules/fflate/esm/index.mjs");
  const files = unzipSync(bytes);
  const ours = Object.entries(files).filter(([name]) => name.includes(config.threadId));
  const text = ours.map(([, data]) => strFromU8(data)).join("\n");
  out("export_files", ours.length);
  out("export_card_text", text.includes("e2e explorer:"));
  out("export_structured", text.includes("e2e-structured-only"));
  out("export_template", text.includes("e2e-template-marker"));
}

const MODES = {
  fixtures,
  turn,
  "apps-setup": appsSetup,
  "apps-member": appsMember,
  "apps-results": appsResults,
  "apps-call": appsCall,
  "apps-launch": appsLaunch,
  "apps-entries": appsEntries,
  "apps-forged": appsForged,
  "apps-drift": appsDrift,
  "apps-share": appsShare,
  "apps-export": appsExport,
};
const mode = MODES[config.mode];
if (!mode) {
  console.error(`unknown mode ${config.mode}`);
  process.exit(2);
}
await mode();
