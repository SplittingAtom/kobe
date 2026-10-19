// Gate 5 (KOBE-227, v1.1 Conversation) harness, client side: the checks the browser cannot make.
// e2e/gate5.sh runs this inside a Kobe server pod (`node --input-type=module -e`) after the Gate 1-3
// clients' helpers (everything above `const MODES` in e2e/gate1/client.mjs, gate2 and gate3:
// config, client(), db(), userClient(), ownerClient(), signedInAs(), turn(), agent(), ...). Every
// step prints `key=value` lines. The database is read for evidence only (audit rows, run_usage).

/** The models the browser checks need (e2e/gate5.sh): the team default and a second one. */
async function g5Models() {
  const admin = await signedInAs(config.admin);
  if (config.window) {
    // The fake model (CI): a catalog entry with a known context window, as the team default.
    const owner = await ownerClient();
    const listed = await owner.call("GET", "/v1/site/models");
    const present = JSON.stringify(listed.json.catalog ?? []).includes(`"alias":"${config.alias}"`);
    if (!present) {
      const made = await owner.call("POST", "/v1/site/models/catalog", {
        alias: config.alias,
        provider_id: config.providerId,
        model: "gpt-fake",
        context_window: config.window,
      });
      out("catalog", code(made));
    } else {
      const patched = await owner.call("PATCH", `/v1/site/models/catalog/${config.alias}`, {
        context_window: config.window,
      });
      out("catalog", code(patched));
    }
  }
  const def = await admin.call("PUT", `/v1/team/models/${config.alias}`, {
    enabled: true,
    is_default: true,
  });
  out("team_default", def.status);
  if (config.second) {
    const second = await admin.call("PUT", `/v1/team/models/${config.second}`, { enabled: true });
    out("team_second", second.status);
  }
  // Runs need Bifrost to have the change: wait (bounded) for the gateway sync.
  const owner = await ownerClient();
  let inSync = false;
  for (let i = 0; i < 30 && !inSync; i += 1) {
    inSync = (await owner.call("GET", "/v1/site/models")).json.gateway?.in_sync === true;
    if (!inSync) await sleep(2_000);
  }
  out("gateway_in_sync", inSync);
}

/** U20: the thread's usage read (what the gauge shows) against run_usage and the window. */
async function g5Usage() {
  const c = await signedInAs(config.user);
  const usage = await c.call("GET", `/v1/threads/${config.threadId}/usage`);
  const latest = usage.json.latest_call ?? {};
  out(
    "usage_latest",
    `${usage.status}:${(latest.input_tokens ?? 0) + (latest.cache_read_tokens ?? 0) + (latest.cache_write_tokens ?? 0)}`,
  );
  const database = await db();
  const { withTeam, sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
  try {
    const rows = await withTeam(database.db, config.user.teamId, (tx) =>
      tx.execute(sql`
        SELECT input_tokens + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0) AS prompt
          FROM run_usage WHERE team_id = ${config.user.teamId} AND thread_id = ${config.threadId}
         ORDER BY at DESC, id DESC LIMIT 1`),
    );
    out("run_usage_latest", rows.rows[0]?.prompt ?? "-");
    const window = await database.pool.query(
      "SELECT context_window FROM model_catalog WHERE alias = $1",
      [config.alias],
    );
    out("context_window", window.rows[0]?.context_window ?? "-");
  } finally {
    await database.close();
  }
}

/** U23: a thread with no title gets one after its first run; a rename locks it for later runs. */
async function g5Title() {
  const c = await signedInAs(config.user);
  const made = await c.call("POST", "/v1/threads", {});
  const t = made.json.thread_id;
  out("thread", t ?? "-");
  if (!t) return;
  const send = async (content) => {
    const sent = await c.call("POST", `/v1/threads/${t}/messages`, { content });
    if (!sent.json.run_id) return `${sent.status}:-`;
    const seen = await follow(c, sent.json.run_id, 300_000);
    return seen.terminal?.type ?? "none";
  };
  // The lock is not in the API: read it from the thread's row (evidence only).
  const lockedOf = async () => {
    const database = await db();
    const { withTeam, sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
    try {
      const rows = await withTeam(database.db, config.user.teamId, (tx) =>
        tx.execute(sql`SELECT title_locked FROM threads
          WHERE team_id = ${config.user.teamId} AND id = ${t}`),
      );
      return rows.rows[0]?.title_locked ?? "-";
    } finally {
      await database.close();
    }
  };
  const titleNow = async () => {
    const json = (await c.call("GET", `/v1/threads/${t}`)).json;
    return { ...json, title_locked: await lockedOf() };
  };
  out("run1", await send("No tools. Reply with the single word TITLE."));
  let auto = await titleNow();
  for (let i = 0; i < 30 && !auto.title; i += 1) {
    await sleep(2_000);
    auto = await titleNow();
  }
  out("title_auto", `${auto.title ? "set" : "none"}:locked=${auto.title_locked ?? "-"}`);
  const renamed = await c.call("PATCH", `/v1/threads/${t}`, { title: config.title });
  out("rename", code(renamed));
  const after = await titleNow();
  out("title_after_rename", `${after.title === config.title}:locked=${after.title_locked ?? "-"}`);
  out("run2", await send("No tools. Reply with the single word AGAIN."));
  // The post-run title call follows the run's end: give it the time the first one took, twice.
  await sleep(10_000);
  const kept = await titleNow();
  out("title_kept", `${kept.title === config.title}:${oneLine(kept.title ?? "-").slice(0, 80)}`);
}

/** U24: what a team admin sees of a member's thread, then the share and its audit trail. */
async function g5Share() {
  const author = await signedInAs(config.author);
  const admin = await signedInAs(config.admin);
  const t = config.threadId;
  out("admin_private", code(await admin.call("GET", `/v1/threads/${t}`)));
  const listed = async () =>
    ((await admin.call("GET", "/v1/threads")).json.threads ?? []).some((x) => x.thread_id === t);
  out("admin_listed_private", await listed());
  const shared = await author.call("POST", `/v1/threads/${t}/share`, { visibility: "team" });
  out("share", `${shared.status}:${shared.json.visibility ?? shared.json.code ?? "-"}`);
  const seen = await admin.call("GET", `/v1/threads/${t}`);
  out("admin_shared", `${seen.status}:read_only=${seen.json.read_only}`);
  const revoked = await author.call("POST", `/v1/threads/${t}/share`, { visibility: "private" });
  out("revoke", `${revoked.status}:${revoked.json.visibility ?? revoked.json.code ?? "-"}`);
  out("admin_after_revoke", code(await admin.call("GET", `/v1/threads/${t}`)));
  const database = await db();
  const { withTeam, sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
  try {
    const rows = await withTeam(database.db, config.author.teamId, (tx) =>
      tx.execute(sql`
        SELECT actor_id, target ->> 'visibility' AS visibility, target ->> 'from' AS "from"
          FROM audit_log WHERE team_id = ${config.author.teamId} AND action = 'thread.sharing_changed'
           AND target ->> 'threadId' = ${t} ORDER BY seq`),
    );
    out(
      "audit",
      rows.rows
        .map(
          (r) =>
            `${r.from}>${r.visibility}:${r.actor_id === config.author.userId ? "author" : "other"}`,
        )
        .join(",") || "-",
    );
  } finally {
    await database.close();
  }
}

const MODES = {
  fixtures,
  turn,
  agent,
  role,
  "g5-models": g5Models,
  "g5-usage": g5Usage,
  "g5-title": g5Title,
  "g5-share": g5Share,
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
  console.error(`gate5 ${config.mode} failed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
}
