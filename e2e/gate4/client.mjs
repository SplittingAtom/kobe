// Gate 4 (KOBE-4, v1.0) harness, client side, part 1 of 2 (KOBE-232): the user stories Gates 1-3
// do not cover (U1, U2's per-team memory, U5, U6, U11's warning and dashboard, U14, U15's
// search). e2e/gate4.sh runs it inside a Kobe server pod after the Gate 1, 2 and 3 clients'
// helpers (everything above their MODES: client(), userClient(), signedInAs(), turn(), ...);
// e2e/gate4/connectors.mjs follows with U7 and U8 and the MODES. Every step prints key=value
// lines. The database is read for evidence and written only to move time (an approval's expiry,
// a schedule's next run) and to put a site setting back that its own API cannot undo (below).

const later = (ms) => new Promise((r) => setTimeout(r, ms));
const statusOf = (r) => `${r.status}:${r.json.code ?? "-"}`;
const ownerSession = () => ownerClient();

// --- U1: invite email → account, password and passkey, 2FA when required, only invited teams ------

/** A software WebAuthn authenticator (ES256, "none" attestation), as in services/server's tests. */
function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(n, 1);
  return b;
}
function cbor(v) {
  if (typeof v === "number") return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === "string")
    return Buffer.concat([cborHead(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  if (v instanceof Map) {
    return Buffer.concat([cborHead(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  }
  throw new Error(`cbor: unsupported ${typeof v}`);
}
async function authenticator(rpId, origin) {
  const { createHash, createSign, generateKeyPairSync, randomBytes } = await import("node:crypto");
  const sha = (b) => createHash("sha256").update(b).digest();
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const id = randomBytes(16);
  let count = 0;
  let userHandle;
  const authData = (flags, attested) => {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(count);
    const parts = [sha(rpId), Buffer.from([flags]), c];
    if (attested) {
      const jwk = publicKey.export({ format: "jwk" });
      const len = Buffer.alloc(2);
      len.writeUInt16BE(id.length);
      const key = new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]);
      parts.push(Buffer.alloc(16), len, id, cbor(key));
    }
    return Buffer.concat(parts);
  };
  const clientData = (type, challenge) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const base = {
    id: id.toString("base64url"),
    rawId: id.toString("base64url"),
    type: "public-key",
  };
  return {
    register(options) {
      userHandle = options.user.id;
      const att = new Map([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData(0x45, true)], // UP | UV | AT
      ]);
      return {
        ...base,
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData("webauthn.create", options.challenge).toString("base64url"),
          attestationObject: cbor(att).toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    authenticate(options) {
      count += 1;
      const data = authData(0x05, false); // UP | UV
      const cd = clientData("webauthn.get", options.challenge);
      const signature = createSign("sha256")
        .update(Buffer.concat([data, sha(cd)]))
        .sign(privateKey);
      return {
        ...base,
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        response: {
          clientDataJSON: cd.toString("base64url"),
          authenticatorData: data.toString("base64url"),
          signature: signature.toString("base64url"),
          userHandle,
        },
      };
    },
  };
}

function totp(uri, at = Date.now()) {
  return import("node:crypto").then(({ createHmac }) => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const secret = new URL(uri).searchParams.get("secret").replace(/=+$/, "").toUpperCase();
    const bits = [...secret]
      .map((ch) => alphabet.indexOf(ch).toString(2).padStart(5, "0"))
      .join("");
    const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
    const h = createHmac("sha1", key).update(counter).digest();
    const o = h[h.length - 1] & 0x0f;
    return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
  });
}

/** The Owner invites a new person to the site: the invitation is mailed (no token here). */
async function u1Invite() {
  const owner = await ownerSession();
  const r = await owner.call("POST", "/v1/site/invites", { email: config.email });
  out("site_invite", statusOf(r));
}

const teamSlugs = (r) =>
  [...r.text.matchAll(/"slug":"([^"]+)"/g)]
    .map((m) => m[1])
    .sort()
    .join(",");

/** The invitee accepts with a password, joins the team they are invited to, adds a passkey. */
async function u1Account() {
  const ip = `198.51.103.${1 + Math.floor(Math.random() * 250)}`;
  const c = client(ip);
  const accepted = await c.call("POST", "/api/auth/invitation/accept", {
    token: config.token,
    name: "Gate4 Invitee",
    password: PASSWORD,
  });
  out("accept", statusOf(accepted));
  const signed = await c.signIn(config.email);
  out("password_signin", signed.status);
  const before = await c.call("GET", "/v1/me/teams");
  out("teams_before_team_invite", `${before.status}:${teamSlugs(before) || "-"}`);
  const admin = await signedInAs(config.admin);
  const invited = await admin.call("POST", "/v1/team/invites", {
    email: config.email,
    role: "member",
  });
  out("team_invite", invited.status);
  out("team_accept", (await c.call("POST", `/v1/me/invites/${config.teamId}/accept`)).status);
  const teams = await c.call("GET", "/v1/me/teams");
  out("teams", `${teams.status}:${teamSlugs(teams)}`);
  // A session acts in one active team (the chat's switcher, `PUT /v1/me/teams/active`): another
  // team can't be made active, and a request naming it is refused while the own team is active.
  out(
    "other_team",
    statusOf(await c.call("PUT", "/v1/me/teams/active", { teamId: config.otherTeamId })),
  );
  out("own_team_active", await c.useTeam(config.teamId));
  c.team = config.otherTeamId;
  out("other_team_named", statusOf(await c.call("GET", "/v1/threads")));
  c.team = config.teamId;
  out("own_team", (await c.call("GET", "/v1/threads")).status);
  // A passkey (WebAuthn, user verification required), then a sign-in with it alone.
  const origin = new URL(process.env.KOBE_PUBLIC_URL).origin;
  const key = await authenticator(new URL(origin).hostname, origin);
  const options = await c.call("GET", "/api/auth/passkey/generate-register-options");
  const reg = await c.call("POST", "/api/auth/passkey/verify-registration", {
    response: key.register(options.json),
  });
  out("passkey_register", statusOf(reg));
  const fresh = client(`198.51.103.${1 + Math.floor(Math.random() * 250)}`);
  const auth = await fresh.call("GET", "/api/auth/passkey/generate-authenticate-options");
  const pk = await fresh.call("POST", "/api/auth/passkey/verify-authentication", {
    response: key.authenticate(auth.json),
  });
  out("passkey_signin", statusOf(pk));
  const me = await fresh.call("GET", "/v1/me");
  out("passkey_session", `${me.status}:${me.json.email ?? me.json.user?.email ?? "-"}`);
}

/**
 * With the site requiring 2FA, the invitee is held at enrollment, enrolls TOTP, and signs in with
 * password + code. Only the Owner may turn the requirement off, and the Owner (without TOTP) is
 * held too once it is on, so the previous value is put back in the database (try/finally).
 */
async function u1Totp() {
  const owner = await ownerSession();
  const before = await owner.call("GET", "/v1/site/settings");
  const previous = before.json.requireTwoFactor === true;
  out("require_before", previous);
  const database = await db();
  try {
    out(
      "require_on",
      statusOf(await owner.call("PUT", "/v1/site/settings", { requireTwoFactor: true })),
    );
    const c = client(`198.51.103.${1 + Math.floor(Math.random() * 250)}`);
    await c.signIn(config.email);
    c.team = config.teamId;
    out("held", statusOf(await c.call("GET", "/v1/threads")));
    const enable = await c.call("POST", "/api/auth/two-factor/enable", { password: PASSWORD });
    out("enable", enable.status);
    const code = await totp(enable.json.totpURI);
    out("verify", (await c.call("POST", "/api/auth/two-factor/verify-totp", { code })).status);
    await c.useTeam(config.teamId);
    out("after_enroll", (await c.call("GET", "/v1/threads")).status);
    const next = client(`198.51.103.${1 + Math.floor(Math.random() * 250)}`);
    const first = await next.call("POST", "/api/auth/sign-in/email", {
      email: config.email,
      password: PASSWORD,
    });
    out(
      "password_only",
      `${first.status}:two_factor_redirect=${first.json.twoFactorRedirect === true}`,
    );
    next.team = config.teamId;
    out("before_code", (await next.call("GET", "/v1/threads")).status);
    await later(1000);
    const second = await next.call("POST", "/api/auth/two-factor/verify-totp", {
      code: await totp(enable.json.totpURI),
    });
    out("with_code", second.status);
    await next.useTeam(config.teamId);
    out("after_code", (await next.call("GET", "/v1/threads")).status);
  } finally {
    await database.pool.query("UPDATE site_settings SET value = $1 WHERE key = 'require_2fa'", [
      String(previous),
    ]);
    out(
      "require_restored",
      (await owner.call("GET", "/v1/site/settings")).json.requireTwoFactor === previous,
    );
    await database.close();
  }
}

// --- U2: personal memory is per team -------------------------------------------------------------

async function u2Memory() {
  const adminB = await signedInAs(config.adminB);
  out(
    "invite_b",
    (await adminB.call("POST", "/v1/team/invites", { email: config.user.email, role: "member" }))
      .status,
  );
  const c = await signedInAs(config.user);
  out("join_b", (await c.call("POST", `/v1/me/invites/${config.teamB}/accept`)).status);
  const path = config.path;
  c.team = config.user.teamId;
  out(
    "write_a",
    statusOf(await c.call("PUT", "/v1/memory", { scope: "user", path, content: config.content })),
  );
  const listed = async (team) => {
    await c.useTeam(team); // the team switcher: the session's active team, then the header
    const r = await c.call("GET", "/v1/memory?scope=user");
    return `${r.status}:${r.text.includes(`"path":"${path}"`) ? "present" : "absent"}`;
  };
  out("list_a", await listed(config.user.teamId));
  out("list_b", await listed(config.teamB));
}

// --- U5: Enter queues, Steer injects, Stop cancels, one active run per thread ----------------------

/** Follows the run's stream until an event of `type` (true) or its end or the timeout (false). */
async function sawEvent(c, runId, type, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let seen = false;
  try {
    const res = await c.stream(runId, { signal: controller.signal });
    if (res.status === 200) {
      await readEvents(res, (e) => {
        if (e.type === type) seen = true;
        return seen || TERMINAL.has(e.type);
      });
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return seen;
}

async function u5() {
  const c = await signedInAs(config.user);
  const thread = (await c.call("POST", "/v1/threads", { title: "gate4 U5" })).json.thread_id;
  out("thread", thread);
  const a = await c.call("POST", `/v1/threads/${thread}/messages`, { content: config.long });
  out("first", `${a.status}:queued=${a.json.queued}`);
  const runA = a.json.run_id;
  const stopApprover = startApprover(c, runA);
  let started = false;
  for (let i = 0; i < 120 && !started; i += 1) {
    started = (await c.call("GET", `/v1/runs/${runA}`)).json.status === "running";
    if (!started) await later(1000);
  }
  out("first_running", started);
  const b = await c.call("POST", `/v1/threads/${thread}/messages`, { content: config.queued });
  out("second", `${b.status}:queued=${b.json.queued}`);
  const runs = await c.call("GET", `/v1/threads/${thread}/runs`);
  const statuses = (runs.json.runs ?? []).map((r) => r.status);
  out("active_runs", statuses.filter((s) => s === "running").length);
  // Steer while the run works: once Pi is in it (its first tool call, the `sleep`), as a member
  // steers what they see working. `running` alone can precede the sandbox taking the run.
  out("steer_during", (await sawEvent(c, runA, "tool.call", 120_000)) ? "tool.call" : "none");
  const steered = await c.call("POST", `/v1/runs/${runA}/steer`, { content: config.steer });
  out("steer", statusOf(steered));
  if (steered.status !== 200)
    out("steer_message", String(steered.json.message ?? "-").slice(0, 200));
  const seenA = await follow(c, runA, 300_000);
  stopApprover();
  out("first_terminal", seenA.terminal?.type ?? "none");
  out(
    "steer_applied",
    seenA.events.some((e) => e.type === "steer.applied"),
  );
  const textA = seenA.events
    .filter((e) => e.type === "text.delta")
    .map((e) => e.data.payload?.delta ?? "")
    .join("");
  out("first_text", textA.replace(/\s+/g, " ").slice(0, 300));
  const seenB = await follow(c, b.json.run_id, 300_000);
  out("second_terminal", seenB.terminal?.type ?? "none");
  const startedB = Date.parse(seenB.events.find((e) => e.type === "run.started")?.data.ts ?? "");
  const endedA = Date.parse(seenA.terminal?.data.ts ?? "");
  out(
    "second_started_after_first_ended",
    Number.isFinite(startedB) && Number.isFinite(endedA) ? startedB >= endedA : "unknown",
  );
  // Stop: a run that waits for the model, cancelled.
  const s = await c.call("POST", `/v1/threads/${thread}/messages`, { content: config.slow });
  for (let i = 0; i < 120; i += 1) {
    if ((await c.call("GET", `/v1/runs/${s.json.run_id}`)).json.status === "running") break;
    await later(1000);
  }
  const t0 = Date.now();
  out("cancel", statusOf(await c.call("POST", `/v1/runs/${s.json.run_id}/cancel`)));
  const seenS = await follow(c, s.json.run_id, 120_000);
  out(
    "stopped",
    `${seenS.terminal?.type ?? "none"}:${seenS.terminal?.data.payload?.reason ?? "-"}`,
  );
  out("stopped_ms", Date.now() - t0);
}

// --- U6: the approval card, the signed approval, a remember-rule, the 1 h expiry -------------------
// The writes are share_file calls of files already in the member's workspace (config.write*).

async function pendingOf(c, runId, timeoutMs = 120_000) {
  for (let i = 0; i < timeoutMs / 1000; i += 1) {
    const list = await c.call("GET", `/v1/approvals?status=pending&run_id=${runId}`);
    const a = (list.json.approvals ?? [])[0];
    if (a) return a;
    await later(1000);
  }
  return undefined;
}

async function approvalRow(teamId, approvalId) {
  const database = await db();
  const { withTeam, sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
  try {
    const rows = await withTeam(database.db, teamId, (tx) =>
      tx.execute(sql`SELECT status, token_kid IS NOT NULL AND input_hmac IS NOT NULL AS signed,
          extract(epoch FROM expires_at - created_at)::int AS ttl
        FROM approvals WHERE team_id = ${teamId} AND id = ${approvalId}`),
    );
    return rows.rows[0] ?? {};
  } finally {
    await database.close();
  }
}

async function u6() {
  const c = await signedInAs(config.user);
  const thread = (await c.call("POST", "/v1/threads", { title: "gate4 U6" })).json.thread_id;
  out("thread", thread);
  const send = async (content) =>
    (await c.call("POST", `/v1/threads/${thread}/messages`, { content })).json.run_id;
  // 1. The card: tool, input and risk; allowed with a remember-rule; the exact input runs.
  const run1 = await send(config.write);
  const a = await pendingOf(c, run1);
  out(
    "card",
    a
      ? `${a.tool}:${a.risk}:input=${JSON.stringify(a.input ?? {}).includes(config.marker)}`
      : "none",
  );
  const options = a ? await c.call("GET", `/v1/approvals/${a.approval_id}/remember`) : { json: {} };
  const scope = (options.json.choices ?? [])[0]?.scope;
  out("remember_scope", scope ?? "-");
  const decided = a
    ? await c.call("POST", `/v1/approvals/${a.approval_id}`, {
        decision: "allow",
        ...(scope ? { remember: { tool_glob: a.tool, scope, exact: false } } : {}),
      })
    : { status: 0, json: {} };
  out("allow", statusOf(decided));
  const seen1 = await follow(c, run1, 300_000);
  out("run1", seen1.terminal?.type ?? "none");
  // share_file (a Kobe write that asks in ask-on-write; artifacts never ask, by decision): the
  // file it shared is the one the approved input named.
  const shared = seen1.events.find((e) => e.type === "file.shared")?.data.payload;
  out("shared", shared ? `${shared.file_id}:${shared.name}` : "-");
  out("exact_input_ran", shared?.name === config.sharedName);
  if (a) {
    const row = await approvalRow(config.user.teamId, a.approval_id);
    out("approval_row", `${row.status}:signed=${row.signed}`);
  }
  // 2. The rule is visible to its owner; the same call no longer asks.
  const rules = await c.call("GET", "/v1/team/policy/my-rules");
  const rule = (rules.json.rules ?? []).find((r) => r.tool_glob === a?.tool);
  out("rule_listed", rule ? "yes" : "no");
  const run2 = await send(config.write2);
  const seen2 = await follow(c, run2, 300_000);
  out(
    "run2",
    `${seen2.terminal?.type ?? "none"}:asked=${seen2.events.some((e) => e.type === "approval.requested")}`,
  );
  // 3. Revoked, the call asks again.
  out(
    "revoke",
    rule ? (await c.call("DELETE", `/v1/team/policy/my-rules/${rule.id}`)).status : "no_rule",
  );
  const run3 = await send(config.write3);
  const b = await pendingOf(c, run3);
  out("asks_again", b ? "yes" : "no");
  // 4. Unanswered, it expires at 1 h and the run ends visibly: the expiry is moved to now.
  if (b) {
    const row = await approvalRow(config.user.teamId, b.approval_id);
    out("ttl_seconds", row.ttl ?? "-");
    const database = await db();
    const { withTeam, sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
    try {
      await withTeam(database.db, config.user.teamId, (tx) =>
        tx.execute(
          sql`UPDATE approvals SET expires_at = now() WHERE team_id = ${config.user.teamId} AND id = ${b.approval_id}`,
        ),
      );
    } finally {
      await database.close();
    }
    const seen3 = await follow(c, run3, 180_000);
    const resolved = seen3.events.find((e) => e.type === "approval.resolved")?.data.payload;
    out("expired", `${resolved?.decision ?? "-"}:${resolved?.cause ?? "-"}`);
    out(
      "run3",
      `${seen3.terminal?.type ?? "none"}:${seen3.terminal?.data.payload?.error?.code ?? "-"}`,
    );
    out("run3_message", (seen3.terminal?.data.payload?.error?.message ?? "-").slice(0, 200));
  }
}

// --- U11: the 80 % warning and the dashboard by user, agent and model -------------------------------

async function u11() {
  const admin = await signedInAs(config.admin);
  const path = `/v1/team/budgets/members/${config.user.userId}`;
  out("budget", (await admin.call("PUT", path, { daily_tokens: config.dailyTokens })).status);
  try {
    const c = await signedInAs(config.user);
    const thread = (await c.call("POST", "/v1/threads", { title: "gate4 U11" })).json.thread_id;
    const sent = await c.call("POST", `/v1/threads/${thread}/messages`, {
      content: config.content,
    });
    const seen = await follow(c, sent.json.run_id, 300_000);
    out("run", seen.terminal?.type ?? "none");
    let status = { json: {} };
    for (let i = 0; i < 30; i += 1) {
      status = await c.call("GET", "/v1/team/budgets/status");
      if (status.json.state === "warning" || status.json.state === "exhausted") break;
      await later(2000);
    }
    const line =
      (status.json.lines ?? []).find((l) => l.state !== "ok") ?? (status.json.lines ?? [])[0];
    out("status", `${status.json.state ?? "-"}:${line?.percent ?? "-"}`);
    const usage = await admin.call("GET", "/v1/team/usage");
    out(
      "by_user",
      (usage.json.by_user ?? []).some((u) => JSON.stringify(u).includes(config.user.userId)),
    );
    out("by_agent", (usage.json.by_agent ?? []).length);
    out("by_model", (usage.json.by_model ?? []).map((m) => m.model).join(",") || "-");
  } finally {
    out("budget_cleared", (await admin.call("DELETE", path)).status);
  }
}

// --- U14: a schedule runs as its owner in auto mode; a write that would ask is skipped ------------

async function u14() {
  const c = await signedInAs(config.user);
  const at = `${String((new Date().getUTCHours() + 12) % 24).padStart(2, "0")}:00`;
  const made = await c.call("POST", "/v1/schedules", {
    agent_id: config.agentId,
    prompt: config.prompt,
    recurrence: { kind: "daily", at },
    tz: "UTC",
    notify_email: false,
  });
  const sid = made.json.schedule_id ?? made.json.schedule?.schedule_id ?? made.json.id;
  out("schedule", `${made.status}:${sid ?? "-"}`);
  if (!sid) return;
  const database = await db();
  const { withTeam, sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
  const t = config.user.teamId;
  const one = async (q) => (await withTeam(database.db, t, (tx) => tx.execute(q))).rows[0] ?? {};
  try {
    await withTeam(database.db, t, (tx) =>
      tx.execute(
        sql`UPDATE schedules SET next_due_at = date_trunc('second', now()) - interval '1 second' WHERE team_id = ${t} AND id = ${sid}`,
      ),
    );
    let runId;
    for (let i = 0; i < 90 && !runId; i += 1) {
      runId = (
        await one(
          sql`SELECT last_run_id::text AS r FROM schedules WHERE team_id = ${t} AND id = ${sid}`,
        )
      ).r;
      if (!runId) await later(1000);
    }
    out("fired", runId ? "yes" : "no");
    if (!runId) return;
    const seen = await follow(c, runId, 300_000);
    out("terminal", seen.terminal?.type ?? "none");
    const run =
      await one(sql`SELECT r.trigger::text AS trigger, r.approval_mode AS mode, th.owner_user_id::text AS owner,
        th.id::text AS thread, th.schedule_id::text AS schedule
      FROM runs r JOIN threads th ON th.team_id = r.team_id AND th.id = r.thread_id
      WHERE r.team_id = ${t} AND r.id = ${runId}`);
    out("run", `${run.trigger}:${run.mode}:owner=${run.owner === config.user.userId}`);
    out("in_scheduled", run.schedule === sid);
    const skipped = (
      await withTeam(database.db, t, (tx) =>
        tx.execute(
          sql`SELECT tool || ':' || reason AS s FROM run_skipped_actions WHERE team_id = ${t} AND run_id = ${runId}`,
        ),
      )
    ).rows.map((r) => r.s);
    out("skipped", skipped.join(",") || "-");
    const done = seen.terminal?.data.payload?.skipped_actions ?? [];
    out("reported", done.map((s) => s.tool).join(",") || "-");
    let kinds = "";
    for (let i = 0; i < 30 && !kinds; i += 1) {
      const notes = await c.call("GET", "/v1/notifications?limit=20");
      kinds = (notes.json.notifications ?? [])
        .filter((n) => n.run_id === runId)
        .map((n) => n.kind)
        .join(",");
      if (!kinds) await later(2000);
    }
    out("notification", kinds || "-");
  } finally {
    await c.call("DELETE", `/v1/schedules/${sid}`);
    await database.close();
  }
}

// --- U15: threads list and search come from Postgres, not the sandbox -------------------------------

async function u15() {
  const c = await signedInAs(config.user);
  const t0 = Date.now();
  const list = await c.call("GET", "/v1/threads");
  out(
    "list",
    `${list.status}:${(list.json.threads ?? []).some((x) => x.thread_id === config.threadId)}`,
  );
  const hits = await c.call("GET", `/v1/threads?q=${encodeURIComponent(config.marker)}`);
  out("search", `${hits.status}:${hits.text.includes(config.threadId)}`);
  out("elapsed_ms", Date.now() - t0);
}
