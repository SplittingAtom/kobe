// Gate 1 (KOBE-1) harness, client side. Runs inside a Kobe server pod (`node --input-type=module
// -e`, see e2e/gate1.sh), so it has the install's database URL and talks to the server through its
// Service: requests spread over the server replicas like real users' do. Each simulated user sends
// its own X-Forwarded-For address (TEST-NET-2), which the server trusts from the pod network, so
// per-IP sign-in limits apply per user as they would behind the ingress.
//
// Usage: node --input-type=module -e "$(cat e2e/gate1/client.mjs)" '<json config>'
// The config's `mode` picks the step; every step prints `key=value` lines (and JSON lines for
// trials) for e2e/gate1.sh to assert on. Nothing here bypasses the API except fixture setup
// (install invitations are issued with the server's own function instead of a mail round trip).

const config = JSON.parse(process.argv[1] ?? "{}");
const BASE = config.base;
const ORIGIN = new URL(process.env.KOBE_PUBLIC_URL).origin;
const PASSWORD = config.password ?? "gate1 user password";
const out = (key, value) => console.log(`${key}=${value}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TERMINAL = new Set(["run.completed", "run.failed", "run.interrupted", "run.budget_stopped"]);
/** Events the server writes before the sandbox has done anything for the run. */
const SERVER_SIDE = new Set(["run.started", "run.queued", "sandbox.waking", "steer.applied"]);

function client(ip) {
  const jar = new Map();
  const headers = (team, extra) => ({
    origin: ORIGIN,
    "content-type": "application/json",
    "x-forwarded-for": ip,
    ...(team ? { "x-kobe-team": team } : {}),
    cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    ...extra,
  });
  const keep = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  };
  const self = {
    team: undefined,
    async call(method, path, body) {
      const res = await fetch(BASE + path, {
        method,
        headers: headers(self.team),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      keep(res);
      const text = await res.text();
      let json = {};
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON
      }
      return { status: res.status, json, text };
    },
    /** Opens a run's event stream; `lastEventId` resumes like EventSource after a reconnect. */
    async stream(runId, { lastEventId, signal } = {}) {
      return fetch(`${BASE}/v1/runs/${runId}/events`, {
        headers: headers(self.team, {
          accept: "text/event-stream",
          ...(lastEventId === undefined ? {} : { "last-event-id": String(lastEventId) }),
        }),
        signal,
      });
    },
    async signIn(email, password = PASSWORD) {
      const res = await self.call("POST", "/api/auth/sign-in/email", { email, password });
      return res;
    },
    async useTeam(teamId) {
      self.team = teamId;
      return (await self.call("PUT", "/v1/me/teams/active", { teamId })).status;
    },
  };
  return self;
}

/** Reads an SSE response; calls onEvent({seq, type, data}) per event; resolves when it ends. */
async function readEvents(res, onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let at;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const fields = {};
        for (const line of block.split("\n")) {
          const colon = line.indexOf(":");
          if (colon <= 0) continue;
          fields[line.slice(0, colon)] = line.slice(colon + 1).replace(/^ /, "");
        }
        if (fields.id === undefined || fields.event === undefined) continue;
        const stop = onEvent({
          seq: Number(fields.id),
          type: fields.event,
          data: JSON.parse(fields.data ?? "null"),
        });
        if (stop === true) return "stopped";
      }
    }
  } catch (err) {
    if (err?.name === "AbortError") return "aborted";
    throw err;
  }
  return "ended";
}

/** Every event of a run from the start (an ended run replays its whole log). */
async function replay(c, runId) {
  const res = await c.stream(runId);
  if (res.status !== 200) return { status: res.status, events: [] };
  const events = [];
  await readEvents(res, (e) => {
    events.push(e);
  });
  return { status: 200, events };
}

/** The reply the scripted agent streams for a prompt (gate1.sh AGENT_JS builds the same). */
function expectedReply(prompt, words) {
  return [`Reply to ${prompt}:`, ...Array.from({ length: words }, (_, i) => `w${i + 1}`)].join(" ");
}

// --- fixtures -------------------------------------------------------------------------------

async function db() {
  const { createDb } = await import("/app/node_modules/@kobe/db/dist/index.js");
  return createDb(process.env.KOBE_DATABASE_URL, { max: 2 });
}

async function ensureUser(owner, ownerId, user, database) {
  const c = client(user.ip);
  if ((await c.signIn(user.email)).status === 200) return c;
  const { issueInvite } = await import("/app/dist/invitations/install-invites.js");
  const { runWithAuditContext } = await import("/app/dist/audit/context.js");
  // Audited as the Owner, like POST /v1/install/invites (which mails the token instead).
  const invite = await runWithAuditContext(
    { actor: { kind: "user", id: ownerId }, ip: null, userAgent: "kobe-gate1" },
    () => issueInvite(database.db, { email: user.email, invitedBy: ownerId }),
  );
  if (invite === "user_exists") throw new Error(`${user.email} exists but cannot sign in`);
  const accepted = await c.call("POST", "/api/auth/invitation/accept", {
    token: invite.token,
    name: user.name,
    password: PASSWORD,
  });
  if (accepted.status !== 200) throw new Error(`accept ${user.email}: ${accepted.text}`);
  return c;
}

async function fixtures() {
  const owner = client("198.51.100.250");
  const setup = await owner.call("GET", "/v1/setup");
  if (setup.json.required === true) {
    if (!config.setupToken) throw new Error("first-run setup is required: no setup token given");
    const made = await owner.call("POST", "/v1/setup", {
      email: config.owner.email,
      name: "Owner",
      password: config.owner.password,
      setupToken: config.setupToken,
    });
    out("setup", made.status);
  }
  const signedIn = await owner.signIn(config.owner.email, config.owner.password);
  if (signedIn.status !== 200) throw new Error(`owner sign-in: ${signedIn.text}`);
  const ownerId = signedIn.json.user.id;
  const database = await db();
  const clients = new Map();
  const ids = new Map();
  try {
    for (const user of config.users) {
      const c = await ensureUser(owner, ownerId, user, database);
      const me = await c.call("GET", "/v1/me");
      clients.set(user.key, c);
      ids.set(user.key, me.json.id ?? me.json.user?.id);
    }
  } finally {
    await database.close();
  }
  const listed = await owner.call("GET", "/v1/install/teams");
  const teamIds = {};
  for (const team of config.teams) {
    const members = config.users.filter((u) => u.team === team.key);
    const admin = members[0];
    let id = (listed.json.teams ?? []).find((t) => t.slug === team.slug)?.id;
    if (!id) {
      const made = await owner.call("POST", "/v1/install/teams", {
        slug: team.slug,
        name: team.name,
        adminUserId: ids.get(admin.key),
      });
      if (made.status !== 201) throw new Error(`team ${team.slug}: ${made.text}`);
      id = made.json.team.id;
    }
    teamIds[team.key] = id;
    const ac = clients.get(admin.key);
    await ac.useTeam(id);
    for (const member of members.slice(1)) {
      const mc = clients.get(member.key);
      if ((await mc.useTeam(id)) === 200) continue; // already a member
      const invited = await ac.call("POST", "/v1/team/invites", {
        email: member.email,
        role: "member",
      });
      if (invited.status !== 202) throw new Error(`invite ${member.email}: ${invited.text}`);
      const accepted = await mc.call("POST", `/v1/me/invites/${id}/accept`);
      if (accepted.status !== 200) throw new Error(`join ${member.email}: ${accepted.text}`);
    }
  }
  for (const user of config.users) {
    const status = await clients.get(user.key).useTeam(teamIds[user.team]);
    out(`member_${user.key}`, status);
  }
  // KOBE-41: each team's admin enables the install's `fast` model as the team default, so runs
  // get a real model (e2e/run.sh configured the catalog against the fake upstream). 404: no such
  // catalog entry on this install (a real cluster's throwaway install): runs have no model.
  for (const team of config.teams) {
    const admin = config.users.find((u) => u.team === team.key);
    const ac = clients.get(admin.key);
    await ac.useTeam(teamIds[team.key]);
    const enabled = await ac.call("PUT", `/v1/team/models/${config.modelAlias ?? "fast"}`, {
      enabled: true,
      is_default: true,
    });
    out(`models_${team.key}`, enabled.status);
  }
  console.log(
    `fixtures=${JSON.stringify({ teams: teamIds, users: Object.fromEntries(ids), owner: ownerId })}`,
  );
}

// --- chat (concurrency, refresh mid-run) ---------------------------------------------------

/**
 * One user's chat: sign in, new thread, send a message, follow the run's event stream. With
 * `refresh`, drops the stream after `refreshAfter` text deltas (a reload) and reopens it with
 * Last-Event-ID = the last seq it saw, like EventSource. Returns what it observed.
 */
async function chatOne(user) {
  const c = client(user.ip);
  const signin = await c.signIn(user.email);
  if (signin.status !== 200) return { key: user.key, error: `sign-in ${signin.status}` };
  await c.useTeam(user.teamId);
  const thread = await c.call("POST", "/v1/threads", { title: `gate1 ${user.key}` });
  const threadId = thread.json.thread_id;
  const prompt = `gate1 ${user.key} ${config.nonce}`;
  const sent = await c.call("POST", `/v1/threads/${threadId}/messages`, { content: prompt });
  const runId = sent.json.run_id;
  if (sent.status !== 201 || !runId) return { key: user.key, error: `message ${sent.text}` };
  const received = [];
  let deltas = 0;
  let refreshedAt;
  let terminal;
  const deadline = Date.now() + (config.timeoutMs ?? 240_000);
  for (let attempt = 0; terminal === undefined && Date.now() < deadline; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadline - Date.now());
    const last = received.at(-1)?.seq;
    const res = await c.stream(runId, { lastEventId: last, signal: controller.signal });
    if (res.status !== 200) {
      clearTimeout(timer);
      if (res.status === 204) break; // ended and nothing after the cursor
      return { key: user.key, runId, error: `stream ${res.status}` };
    }
    await readEvents(res, (e) => {
      received.push(e);
      if (e.type === "text.delta") deltas += 1;
      if (TERMINAL.has(e.type)) terminal = e;
      if (
        config.refresh &&
        refreshedAt === undefined &&
        terminal === undefined &&
        deltas >= (config.refreshAfter ?? 5)
      ) {
        refreshedAt = e.seq; // the reload: drop the connection mid-run
        controller.abort();
      }
    });
    clearTimeout(timer);
    if (refreshedAt !== undefined && terminal === undefined) await sleep(300);
  }
  const seqs = received.map((e) => e.seq);
  const gapless = seqs.every((s, i) => s === i + 1);
  const full = await replay(c, runId);
  const sameAsLog =
    full.events.length === received.length &&
    full.events.every((e, i) => e.seq === received[i].seq && e.type === received[i].type);
  const text = received
    .filter((e) => e.type === "text.delta")
    .map((e) => e.data.payload?.delta ?? "")
    .join("");
  return {
    key: user.key,
    team: user.teamId,
    threadId,
    runId,
    prompt,
    terminal: terminal?.type ?? "none",
    error: terminal?.type === "run.failed" ? terminal.data.payload?.error?.code : undefined,
    errorMessage:
      terminal?.type === "run.failed" ? terminal.data.payload?.error?.message : undefined,
    events: received.length,
    types: [...new Set(received.map((e) => e.type))].join(","),
    gapless,
    duplicates: new Set(seqs).size !== seqs.length,
    sameAsLog,
    refreshedAt,
    text,
    client: c,
  };
}

async function chat() {
  const users = config.users;
  const started = performance.now();
  const results = await Promise.all(users.map((u) => chatOne(u)));
  out("elapsed_ms", Math.round(performance.now() - started));
  out("users", results.filter((r) => r.runId).length);
  // Nobody sees anyone else's run or thread: a teammate's and another team's answer 404.
  let crossChecks = 0;
  let crossLeaks = 0;
  for (const r of results) {
    if (!r.client) continue;
    for (const other of results) {
      if (other === r || !other.runId) continue;
      const stream = await r.client.stream(other.runId);
      const status = stream.status;
      await stream.body?.cancel().catch(() => {});
      const thread = await r.client.call("GET", `/v1/threads/${other.threadId}`);
      crossChecks += 2;
      if (status !== 404) crossLeaks += 1;
      if (thread.status !== 404) crossLeaks += 1;
    }
  }
  out("cross_checks", crossChecks);
  out("cross_leaks", crossLeaks);
  for (const r of results) {
    const expected = config.kind === "stream" ? expectedReply(r.prompt, config.words) : undefined;
    const fields = {
      user: r.key,
      terminal: r.terminal,
      error: r.error ?? "-",
      events: r.events,
      gapless: r.gapless,
      duplicates: r.duplicates,
      same_as_log: r.sameAsLog,
      refreshed_at: r.refreshedAt ?? "-",
      text: expected === undefined ? "-" : r.text === expected ? "exact" : "mismatch",
      types: r.types,
    };
    console.log(
      "chat " +
        Object.entries(fields)
          .map(([k, v]) => `${k}=${v}`)
          .join(" "),
    );
    if (r.errorMessage) console.log(`     ${r.key} run.failed: ${r.errorMessage.split("\n")[0]}`);
  }
  console.log(
    `runs=${JSON.stringify(Object.fromEntries(results.map((r) => [r.key, { run: r.runId, thread: r.threadId }])))}`,
  );
}

// --- sandbox wire identities ---------------------------------------------------------------

/** Open wire connections per (team, user), read as the app role inside each team (RLS). */
async function connections() {
  const database = await db();
  const { withTeam, sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
  try {
    for (const u of config.users) {
      const rows = await withTeam(database.db, u.teamId, (tx) =>
        tx.execute(sql`
          SELECT s.sandbox_id, s.state,
                 (SELECT count(*)::int FROM sandbox_connections c
                   WHERE c.team_id = s.team_id AND c.user_id = s.user_id
                     AND c.closed_at IS NULL) AS open,
                 (SELECT count(*)::int FROM sandbox_connections c
                   WHERE c.team_id = s.team_id AND c.user_id = s.user_id
                     AND c.closed_at IS NULL AND c.sandbox_id <> s.sandbox_id) AS foreign_open
            FROM sandboxes s
           WHERE s.team_id = ${u.teamId} AND s.user_id = ${u.userId}`),
      );
      const r = rows.rows[0];
      console.log(
        r
          ? `conn ${u.key} open=${r.open} sandbox=${r.sandbox_id}:${r.state} other_sandbox_open=${r.foreign_open}`
          : `conn ${u.key} open=0 sandbox=-`,
      );
    }
  } finally {
    await database.close();
  }
}

/** Sandbox-wire session tokens signed with the install's key (throwaway installs only). */
async function mint() {
  const { signSessionToken } = await import("/app/dist/sandbox/session-token.js");
  const { sessionKeyEnvName } = await import("/app/dist/sandbox/config.js");
  const aud = "kobe.sandbox-wire";
  const now = Math.floor(Date.now() / 1000);
  for (const id of config.identities) {
    const token = signSessionToken(
      {
        iss: "kobe-server",
        aud,
        sub: id.sandboxId,
        team_id: id.teamId,
        user_id: id.userId,
        iat: now,
        exp: now + 1800,
        jti: `gate1-${now}-${Math.random().toString(36).slice(2)}`,
      },
      process.env[sessionKeyEnvName(aud)],
    );
    console.log(`token ${id.key} ${token}`);
  }
}

// --- cross-team probe on the live install --------------------------------------------------

/**
 * The cross-team probe against this install's real data (the CI `db` job runs the full suite on
 * seeded fixtures): every team table, read as the app role with raw SQL and no app filter.
 */
async function probe() {
  const database = await db();
  const kdb = await import("/app/node_modules/@kobe/db/dist/index.js");
  const { withTeam, sql, TEAM_TABLES, quoteIdent } = kdb;
  const [a, b] = config.teams;
  let outside = 0;
  let foreign = 0;
  const withRows = [];
  try {
    for (const table of TEAM_TABLES) {
      const t = sql.raw(quoteIdent(table));
      const o = await database.pool.query(`SELECT count(*)::int AS n FROM ${quoteIdent(table)}`);
      outside += o.rows[0].n;
      for (const [mine, theirs] of [
        [a, b],
        [b, a],
      ]) {
        const counts = await withTeam(database.db, mine, (tx) =>
          tx.execute(sql`
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE team_id <> ${mine})::int AS foreign_rows,
                   count(*) FILTER (WHERE team_id = ${theirs})::int AS theirs
              FROM ${t}`),
        );
        const row = counts.rows[0];
        foreign += row.foreign_rows + row.theirs;
        if (mine === a && row.total > 0) withRows.push(table);
      }
    }
  } finally {
    await database.close();
  }
  out("probe_tables", TEAM_TABLES.length);
  out("probe_outside_rows", outside);
  out("probe_cross_team_rows", foreign);
  out("probe_tables_with_team_a_rows", withRows.length);
  out("probe_team_a_tables", withRows.join(","));
}

// --- interrupted run + Retry ---------------------------------------------------------------

async function signedIn(user, ip = user.ip) {
  const c = client(ip);
  const res = await c.signIn(user.email);
  if (res.status !== 200) throw new Error(`sign-in ${user.email}: ${res.status}`);
  await c.useTeam(user.teamId);
  return c;
}

const entryIds = async (c, threadId) =>
  ((await c.call("GET", `/v1/threads/${threadId}`)).json.entries ?? []).map((e) => e.entry_id);

/** Starts a run on the scripted agent and returns once its partial answer is in Postgres. */
async function interruptStart() {
  const c = await signedIn(config.user);
  const thread = await c.call("POST", "/v1/threads", { title: "gate1 interrupted" });
  const threadId = thread.json.thread_id;
  const sent = await c.call("POST", `/v1/threads/${threadId}/messages`, {
    content: `gate1 long job ${config.nonce}`,
  });
  out("message", `${sent.status}:${sent.json.queued}`);
  out("thread", threadId);
  out("run", sent.json.run_id);
  let ids = [];
  for (let i = 0; i < 60 && ids.length < 3; i += 1) {
    ids = await entryIds(c, threadId);
    if (ids.length < 3) await sleep(1000);
  }
  out("entries_before", ids.join(","));
  out("status_before", (await c.call("GET", `/v1/runs/${sent.json.run_id}`)).json.status);
}

/** After the kill: the run ends interrupted, Retry runs first, history is intact. */
async function interruptRetry() {
  const c = await signedIn(config.user);
  const { threadId, runId } = config;
  const started = performance.now();
  const res = await c.stream(runId);
  let terminal;
  const types = [];
  if (res.status === 200) {
    await readEvents(res, (e) => {
      types.push(e.type);
      if (TERMINAL.has(e.type)) terminal = e;
    });
  }
  out("interrupted_after_ms", Math.round(performance.now() - started));
  out("terminal", terminal?.type ?? `none:${res.status}`);
  out("run_events", types.filter((t) => t.startsWith("run.")).join(","));
  out(
    "interrupted_payload",
    `${terminal?.data.payload?.reason}:${terminal?.data.payload?.retryable === true}`,
  );
  out("thread_status", (await c.call("GET", `/v1/threads/${threadId}`)).json.status);
  const runs = await c.call("GET", `/v1/threads/${threadId}/runs`);
  out("interrupted_run", runs.json.interrupted_run?.run_id === runId ? "this" : "other");
  const before = await entryIds(c, threadId);
  out(
    "history_after_kill",
    before.join(",") === config.entriesBefore ? "intact" : before.join(","),
  );
  const retry = await c.call("POST", `/v1/runs/${runId}/retry`);
  out("retry", `${retry.status}:${retry.json.queued}`);
  const again = await c.call("POST", `/v1/runs/${runId}/retry`);
  out("retry_again", again.json.run_id === retry.json.run_id ? "same" : again.status);
  const snap = await c.call("GET", `/v1/runs/${retry.json.run_id}`);
  out("retry_links", snap.json.retry_of_run_id === runId);
  // The retry goes to the user's real sandbox (woken, its thread restored from Postgres).
  const follow = await c.stream(retry.json.run_id);
  let retryTerminal;
  const retryTypes = [];
  if (follow.status === 200) {
    await readEvents(follow, (e) => {
      retryTypes.push(e.type);
      if (TERMINAL.has(e.type)) retryTerminal = e;
    });
  }
  out("retry_events", retryTypes.join(","));
  out(
    "retry_terminal",
    `${retryTerminal?.type ?? "none"}:${retryTerminal?.data.payload?.error?.code ?? "-"}`,
  );
  const after = await entryIds(c, threadId);
  const kept = before.length > 0 && before.every((id) => after.includes(id));
  out("history_after_retry", kept ? "intact" : `${before.join(",")} -> ${after.join(",")}`);
}

// --- cold start to the model call ----------------------------------------------------------

/**
 * One cold-start trial: the sandbox is hibernated (gate1.sh); time from sending a message to the
 * first event the sandbox produced for the run. With a model that is the first `text.delta`; until
 * Pi has one (KOBE-40/41) it is Pi's refusal of the prompt for lack of a key (`run.failed`
 * `pi_rejected`): everything up to the model request, nothing of the model's own latency.
 */
async function trial() {
  // One address per trial: back-to-back trials sign in faster than the per-IP sign-in limit.
  const c = await signedIn(config.user, `198.51.101.${(config.trial % 250) + 1}`);
  let threadId = config.threadId;
  if (!threadId) {
    threadId = (await c.call("POST", "/v1/threads", { title: "gate1 cold start" })).json.thread_id;
  }
  const t0 = performance.now();
  const sent = await c.call("POST", `/v1/threads/${threadId}/messages`, {
    content: `gate1 cold start ${config.nonce}`,
  });
  const runId = sent.json.run_id;
  const at = {};
  let first;
  let terminal;
  const res = await c.stream(runId);
  if (res.status === 200) {
    await readEvents(res, (e) => {
      const ms = Math.round(performance.now() - t0);
      if (e.type === "run.started") at.started ??= ms;
      if (e.type === "sandbox.waking") at.waking ??= ms;
      if (first === undefined && !SERVER_SIDE.has(e.type)) {
        first = { type: e.type, ms, code: e.data.payload?.error?.code };
      }
      if (TERMINAL.has(e.type)) terminal = e.type;
    });
  }
  console.log(
    JSON.stringify({
      trial: config.trial,
      threadId,
      ms: first?.ms ?? null,
      first: first?.type ?? null,
      code: first?.code ?? null,
      started: at.started ?? null,
      waking: at.waking ?? null,
      terminal: terminal ?? null,
      message_status: sent.status,
    }),
  );
}

/** Nearest-rank percentiles of the trial times (same method as KOBE-25's harness). */
function summary() {
  const ms = config.values.filter((v) => typeof v === "number").sort((x, y) => x - y);
  const rank = (p) => ms[Math.max(0, Math.ceil((p / 100) * ms.length) - 1)];
  const p95 = rank(95);
  console.log(
    JSON.stringify({
      summary: true,
      label: config.label,
      trials: ms.length,
      p50: rank(50),
      p95,
      min: ms[0],
      max: ms.at(-1),
      budget: { p95: config.p95Max },
      pass: ms.length === config.expected && p95 <= config.p95Max,
    }),
  );
}

const MODES = {
  fixtures,
  chat,
  connections,
  mint,
  probe,
  "interrupt-start": interruptStart,
  "interrupt-retry": interruptRetry,
  trial,
  summary,
};

const run = MODES[config.mode];
if (!run) {
  console.error(`unknown mode ${config.mode}`);
  process.exit(2);
}
try {
  await run();
  setTimeout(() => process.exit(0), 200).unref();
} catch (err) {
  console.error(`gate1 ${config.mode} failed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
}
