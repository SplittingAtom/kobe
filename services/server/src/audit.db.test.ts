import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_EVENTS, verifyAuditChain } from "@kobe/db";
import { runWithAuditContext } from "./audit/context.js";
import { isolationAuditor } from "./audit/isolation.js";
import { deactivateUser, reactivateUser } from "./users/deactivation.js";
import { RawBody, type TestBrowser } from "./testing/browser.js";
import { openHarness, PASSWORD, type Harness } from "./testing/harness.js";
import { totpFromUri } from "./testing/totp.js";
import { SoftwareAuthenticator } from "./testing/webauthn.js";

/**
 * KOBE-15: every audited path records one metadata-only event, in the action's transaction, with
 * the right actor, team and client address; team admins see only their team's events.
 */
let h: Harness;
const ids = { owner: "", admin: "", alice: "", bob: "", carol: "" };
let owner: TestBrowser;
let admin: TestBrowser;
let alice: TestBrowser;
let finance = "";
let marketing = "";

const email = (who: keyof typeof ids) => `${who}@audit.test`;
const SETUP_TOKEN = "setup-token-for-harness-tests-01";
const PROMPT = "PROMPT-CONTENT-must-never-be-audited";

interface Row {
  seq: number;
  action: string;
  team_id: string | null;
  actor_kind: string;
  actor_id: string | null;
  target: Record<string, unknown>;
  ip: string | null;
  user_agent: string | null;
}

async function head(): Promise<number> {
  const { rows } = await h.admin.query<{ n: string }>(
    `SELECT coalesce(max(seq), 0)::text AS n FROM audit_log`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Events after `mark`, oldest first. */
async function since(mark: number): Promise<Row[]> {
  const { rows } = await h.admin.query<Row>(
    `SELECT seq::int, action, team_id, actor_kind::text, actor_id, target, host(ip) AS ip, user_agent
     FROM audit_log WHERE seq > $1 ORDER BY seq`,
    [mark],
  );
  return rows;
}

/** Runs `fn` and returns the events it recorded. */
async function recorded(fn: () => Promise<unknown>): Promise<Row[]> {
  const mark = await head();
  await fn();
  await h.mailer.settle();
  return since(mark);
}

const actions = (rows: Row[]) => rows.map((r) => r.action);

/** Events after `mark` once at least `count` have landed (off-path writes), within 5 s. */
async function settled(mark: number, count: number): Promise<Row[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    await h.mailer.settle();
    const rows = await since(mark);
    if (rows.length >= count || Date.now() > deadline) return rows;
  }
}

beforeAll(async () => {
  h = await openHarness();
  const setup = await h.browser().post("/v1/setup", {
    setupToken: SETUP_TOKEN,
    email: email("owner"),
    name: "Owner",
    password: PASSWORD,
  });
  expect(setup.status, JSON.stringify(setup.json)).toBe(201);
  ids.owner = setup.json.userId;
  ids.admin = await h.createUser(email("admin"), "admin");
  ids.alice = await h.createUser(email("alice"));
  ids.bob = await h.createUser(email("bob"));
  ids.carol = await h.createUser(email("carol"));
  owner = await h.signIn(email("owner"));
  admin = await h.signIn(email("admin"));
  alice = await h.signIn(email("alice"));
});

afterAll(async () => {
  await h?.close();
});

describe("first-run setup", () => {
  it("records the Owner's creation, by the Owner", async () => {
    const { rows } = await h.admin.query<Row>(
      `SELECT action, actor_kind::text, actor_id, target FROM audit_log WHERE action = 'identity.setup.completed'`,
    );
    expect(rows).toEqual([
      {
        action: "identity.setup.completed",
        actor_kind: "user",
        actor_id: ids.owner,
        target: { ownerUserId: ids.owner },
      },
    ]);
  });
});

describe("auth events", () => {
  it("records a failed sign-in without the password, with the account it named and the client IP", async () => {
    const b = h.browser();
    const rows = await recorded(() =>
      b.post("/api/auth/sign-in/email", { email: email("bob"), password: "wrong-password-xyz" }),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        action: "auth.sign_in.failed",
        actor_kind: "user",
        actor_id: null,
        target: { method: "password", reason: "INVALID_EMAIL_OR_PASSWORD", userId: ids.bob },
        ip: b.ip,
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain("wrong-password-xyz");
  });

  it("records a failed sign-in for an unknown address without the address", async () => {
    const rows = await recorded(() =>
      h.browser().post("/api/auth/sign-in/email", {
        email: "nobody@audit.test",
        password: "whatever-password",
      }),
    );
    expect(rows.map((r) => r.target)).toEqual([
      { method: "password", reason: "INVALID_EMAIL_OR_PASSWORD" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("nobody@audit.test");
  });

  it("records sign-in, sign-out and a password change by the user", async () => {
    const b = h.browser();
    const signIn = await recorded(() =>
      b.post("/api/auth/sign-in/email", { email: email("bob"), password: PASSWORD }),
    );
    expect(signIn).toEqual([
      expect.objectContaining({
        action: "auth.sign_in.succeeded",
        actor_id: ids.bob,
        target: { method: "password" },
        ip: b.ip,
      }),
    ]);
    const changed = await recorded(() =>
      b.post("/api/auth/change-password", {
        currentPassword: PASSWORD,
        newPassword: "another long password",
      }),
    );
    expect(changed.map((r) => [r.action, r.actor_id])).toEqual([
      ["auth.password.changed", ids.bob],
    ]);
    expect(JSON.stringify(changed)).not.toContain("another long password");
    const out = await recorded(() => b.post("/api/auth/sign-out"));
    expect(out.map((r) => [r.action, r.actor_id])).toEqual([["auth.sign_out", ids.bob]]);
  });

  it("records a password reset request and the reset, never the token", async () => {
    // The reset email (and its audit event) is sent off the request path: wait for it.
    const mark = await head();
    await h.browser().post("/api/auth/request-password-reset", { email: email("carol") });
    const requested = await settled(mark, 1);
    expect(requested.map((r) => [r.action, r.actor_id, r.target])).toEqual([
      ["auth.password.reset_requested", null, { userId: ids.carol }],
    ]);
    const token = h.mailer.lastToken(email("carol"));
    const reset = await recorded(() =>
      h.browser().post("/api/auth/reset-password", { token, newPassword: "a fresh new password" }),
    );
    expect(reset.map((r) => [r.action, r.actor_id])).toEqual([["auth.password.reset", ids.carol]]);
    expect(JSON.stringify([...requested, ...reset])).not.toContain(token);
  });

  it("records 2FA enrollment, the 2FA sign-in steps, backup codes and turning 2FA off", async () => {
    const b = await h.signIn(email("alice"));
    let uri = "";
    const enabled = await recorded(async () => {
      const enable = await b.post("/api/auth/two-factor/enable", { password: PASSWORD });
      uri = enable.json.totpURI;
      expect(
        (await b.post("/api/auth/two-factor/verify-totp", { code: totpFromUri(uri) })).status,
      ).toBe(200);
    });
    expect(actions(enabled)).toEqual(["auth.two_factor.enabled"]);
    expect(JSON.stringify(enabled)).not.toContain(new URL(uri).searchParams.get("secret"));

    const fresh = h.browser();
    const steps = await recorded(async () => {
      await fresh.post("/api/auth/sign-in/email", { email: email("alice"), password: PASSWORD });
      await fresh.post("/api/auth/two-factor/verify-totp", { code: "000000" });
      await fresh.post("/api/auth/two-factor/verify-totp", {
        code: totpFromUri(uri, Date.now() + 30_000),
      });
    });
    expect(steps.map((r) => [r.action, r.actor_id, r.target])).toEqual([
      ["auth.sign_in.two_factor_required", ids.alice, { method: "password" }],
      ["auth.sign_in.failed", null, { method: "totp", reason: "INVALID_CODE" }],
      ["auth.sign_in.succeeded", ids.alice, { method: "totp" }],
    ]);

    const codes = await recorded(() =>
      fresh.post("/api/auth/two-factor/generate-backup-codes", { password: PASSWORD }),
    );
    expect(actions(codes)).toEqual(["auth.two_factor.backup_codes_regenerated"]);
    const off = await recorded(() =>
      fresh.post("/api/auth/two-factor/disable", { password: PASSWORD }),
    );
    expect(off.map((r) => [r.action, r.actor_id])).toEqual([
      ["auth.two_factor.disabled", ids.alice],
    ]);
    // Turning 2FA off ends the browser's other sessions (auth.ts); sign in again.
    alice = await h.signIn(email("alice"));
  });

  it("records passkey registration, passkey sign-in and removal", async () => {
    const authenticator = new SoftwareAuthenticator("kobe.test", "http://kobe.test");
    const b = await h.signIn(email("carol"), "a fresh new password");
    const added = await recorded(async () => {
      const options = await b.get("/api/auth/passkey/generate-register-options");
      await b.post("/api/auth/passkey/verify-registration", {
        response: authenticator.register(options.json),
        name: "key",
      });
    });
    expect(added.map((r) => [r.action, r.actor_id])).toEqual([["auth.passkey.added", ids.carol]]);
    const fresh = h.browser();
    const signIn = await recorded(async () => {
      const options = await fresh.get("/api/auth/passkey/generate-authenticate-options");
      await fresh.post("/api/auth/passkey/verify-authentication", {
        response: authenticator.authenticate(options.json),
      });
    });
    expect(signIn.map((r) => [r.action, r.actor_id, r.target])).toEqual([
      ["auth.sign_in.succeeded", ids.carol, { method: "passkey" }],
    ]);
    const [passkey] = (await fresh.get("/api/auth/passkey/list-user-passkeys")).json;
    const removed = await recorded(() =>
      fresh.post("/api/auth/passkey/delete-passkey", { id: passkey.id }),
    );
    expect(removed.map((r) => [r.action, r.target])).toEqual([
      ["auth.passkey.removed", { passkeyId: passkey.id }],
    ]);
  });
});

describe("identity and install events", () => {
  it("records team creation and rename in the new team's audit", async () => {
    const created = await recorded(async () => {
      const res = await admin.post("/v1/install/teams", {
        slug: "finance",
        name: "Finance",
        adminUserId: ids.alice,
      });
      finance = res.json.team.id;
      const other = await admin.post("/v1/install/teams", {
        slug: "marketing",
        name: "Marketing",
        adminUserId: ids.bob,
      });
      marketing = other.json.team.id;
      await admin.patch(`/v1/install/teams/${finance}`, { name: "Finance & Ops" });
    });
    expect(created.map((r) => [r.action, r.team_id, r.actor_id, r.target])).toEqual([
      [
        "identity.team.created",
        finance,
        ids.admin,
        { slug: "finance", name: "Finance", adminUserId: ids.alice },
      ],
      [
        "identity.team.created",
        marketing,
        ids.admin,
        { slug: "marketing", name: "Marketing", adminUserId: ids.bob },
      ],
      ["identity.team.renamed", finance, ids.admin, { name: "Finance & Ops" }],
    ]);
    expect(created[0]?.ip).toBe(admin.ip);
  });

  it("records nothing when the action fails (duplicate slug)", async () => {
    const rows = await recorded(() =>
      admin.post("/v1/install/teams", { slug: "finance", name: "Again", adminUserId: ids.bob }),
    );
    expect(rows).toEqual([]);
  });

  it("records install invitations without their token", async () => {
    let token = "";
    const rows = await recorded(async () => {
      const res = await admin.post("/v1/install/invites", { email: "dana@audit.test" });
      token = h.mailer.lastToken("dana@audit.test");
      await admin.post(`/v1/install/invites/${res.json.invitation.id}/resend`);
      const resent = h.mailer.lastToken("dana@audit.test");
      await h.browser().post("/api/auth/invitation/accept", {
        token: resent,
        name: "Dana",
        password: PASSWORD,
      });
      const revoked = await admin.post("/v1/install/invites", { email: "eve@audit.test" });
      await admin.delete(`/v1/install/invites/${revoked.json.invitation.id}`);
    });
    expect(actions(rows)).toEqual([
      "identity.invitation.created",
      "identity.invitation.resent",
      "identity.invitation.accepted",
      "auth.sign_in.succeeded",
      "identity.invitation.created",
      "identity.invitation.revoked",
    ]);
    const accepted = rows[2];
    expect(accepted?.actor_id).toBe(accepted?.target.userId);
    expect(rows[3]?.target).toEqual({ method: "invitation" });
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("records install role grants, revocations and the ownership transfer", async () => {
    const rows = await recorded(async () => {
      await owner.put(`/v1/install/roles/${ids.carol}`, { role: "admin" });
      await owner.put(`/v1/install/roles/${ids.carol}`, { role: "admin" }); // no change
      await owner.put(`/v1/install/roles/${ids.carol}`, { role: "user" });
      await owner.post("/v1/install/roles/transfer-ownership", { userId: ids.admin });
      await admin.post("/v1/install/roles/transfer-ownership", { userId: ids.owner });
    });
    expect(rows.map((r) => [r.action, r.actor_id, r.target])).toEqual([
      ["identity.install_role.granted", ids.owner, { userId: ids.carol, role: "admin" }],
      ["identity.install_role.revoked", ids.owner, { userId: ids.carol, role: "admin" }],
      ["identity.ownership.transferred", ids.owner, { fromUserId: ids.owner, toUserId: ids.admin }],
      ["identity.ownership.transferred", ids.admin, { fromUserId: ids.admin, toUserId: ids.owner }],
    ]);
  });

  it("records install settings, deactivation and reactivation", async () => {
    const rows = await recorded(async () => {
      await owner.put("/v1/install/settings", { requireTwoFactor: false });
      await admin.post(`/v1/install/users/${ids.carol}/deactivate`);
      await admin.post(`/v1/install/users/${ids.carol}/deactivate`); // already: no event
      await admin.post(`/v1/install/users/${ids.carol}/reactivate`);
    });
    expect(rows.map((r) => [r.action, r.target])).toEqual([
      ["install.settings.updated", { setting: "require_two_factor", value: false }],
      ["identity.user.deactivated", { userId: ids.carol }],
      ["identity.user.reactivated", { userId: ids.carol }],
    ]);
  });
});

describe("team events", () => {
  beforeAll(async () => {
    await alice.put("/v1/me/teams/active", { teamId: finance });
    alice.team = finance;
  });

  it("records team invitations, acceptance and role changes in the team", async () => {
    const carol = await h.signIn(email("carol"), "a fresh new password");
    const rows = await recorded(async () => {
      const inv = await alice.post("/v1/team/invites", { email: email("carol"), role: "member" });
      expect(inv.status, JSON.stringify(inv.json)).toBe(202);
      await carol.post(`/v1/me/invites/${finance}/accept`);
      await alice.patch(`/v1/team/members/${ids.carol}`, { role: "builder" });
      await alice.patch(`/v1/team/members/${ids.alice}`, { role: "member" }); // last admin: refused
      const other = await alice.post("/v1/team/invites", { email: email("bob"), role: "builder" });
      await alice.delete(`/v1/team/invites/${other.json.invitation.id}`);
      await alice.delete(`/v1/team/members/${ids.carol}`);
    });
    expect(rows.every((r) => r.team_id === finance)).toBe(true);
    expect(rows.map((r) => [r.action, r.actor_id, r.target])).toEqual([
      [
        "identity.team_invitation.created",
        ids.alice,
        expect.objectContaining({ email: email("carol"), role: "member" }),
      ],
      [
        "identity.team_invitation.accepted",
        ids.carol,
        { userId: ids.carol, role: "member", invitedBy: ids.alice },
      ],
      [
        "identity.member.role_changed",
        ids.alice,
        { userId: ids.carol, from: "member", to: "builder" },
      ],
      [
        "identity.team_invitation.created",
        ids.alice,
        expect.objectContaining({ email: email("bob"), role: "builder" }),
      ],
      ["identity.team_invitation.revoked", ids.alice, expect.anything()],
      ["identity.member.removed", ids.alice, { userId: ids.carol, role: "builder" }],
    ]);
  });

  it("records agent create, import, fork, update, suspend, export and delete without content", async () => {
    let id = "";
    const rows = await recorded(async () => {
      const created = await alice.post("/v1/agents", {
        scope: "team",
        frontmatter: { name: "Analyst" },
        prompt: PROMPT,
      });
      id = created.json.agent.id;
      const imported = await alice.request(
        "POST",
        "/v1/agents?scope=personal",
        new RawBody(`---\nname: Mine\n---\n${PROMPT}\n`, "text/markdown"),
      );
      expect(imported.status, JSON.stringify(imported.json)).toBe(201);
      await alice.post(`/v1/agents/${id}/fork`, { scope: "team" });
      await alice.put(
        `/v1/agents/${id}`,
        { frontmatter: { name: "Analyst 2" }, prompt: `${PROMPT} v2` },
        { "if-match": '"1"' },
      );
      await alice.put(`/v1/agents/${id}/status`, { status: "suspended" });
      await alice.get(`/v1/agents/${id}/export`);
      await alice.delete(`/v1/agents/${id}`);
    });
    expect(rows.map((r) => [r.action, r.team_id, r.target.source ?? null])).toEqual([
      ["agent.created", finance, "json"],
      ["agent.created", null, "import"],
      ["agent.created", finance, "fork"],
      ["agent.updated", finance, "json"],
      ["agent.status_changed", finance, null],
      ["agent.exported", finance, null],
      ["agent.deleted", finance, null],
    ]);
    expect(rows[2]?.target.forkedFrom).toBe(id);
    expect(rows[3]?.target.revision).toBe(2);
    expect(JSON.stringify(rows)).not.toContain(PROMPT);
  });
});

describe("policy and thread events", () => {
  it("records tool-rule changes and policy switches by metadata, never notes or patterns", async () => {
    let installRule = "";
    let teamRule = "";
    const rows = await recorded(async () => {
      const created = await admin.post("/v1/install/policy/rules", {
        effect: "deny",
        tool_glob: "bash",
        arg_pattern: { "/command": "rm -rf *SECRET-PATTERN*" },
        note: "NOTE-must-not-be-audited",
      });
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      installRule = created.json.rule.id;
      await admin.request("PUT", `/v1/install/policy/rules/${installRule}`, {
        effect: "ask",
        tool_glob: "bash",
        arg_pattern: null,
        note: null,
        expires_at: null,
      });
      await admin.delete(`/v1/install/policy/rules/${installRule}`);
      await admin.put("/v1/install/policy/settings", { promptSandboxWrites: true });
      const team = await alice.post("/v1/team/policy/rules", {
        effect: "deny",
        tool_glob: "write",
      });
      expect(team.status, JSON.stringify(team.json)).toBe(201);
      teamRule = team.json.rule.id;
      await alice.delete(`/v1/team/policy/rules/${teamRule}`);
    });
    expect(
      rows.map((r) => [r.action, r.team_id, r.target.scope ?? null, r.target.effect ?? null]),
    ).toEqual([
      ["policy.rule.created", null, "install", "deny"],
      ["policy.rule.updated", null, "install", "ask"],
      ["policy.rule.deleted", null, "install", "ask"],
      ["policy.settings.updated", null, null, null],
      ["policy.rule.created", finance, "team", "deny"],
      ["policy.rule.deleted", finance, "team", "deny"],
    ]);
    expect(rows[0]?.target).toEqual({
      ruleId: installRule,
      scope: "install",
      effect: "deny",
      toolGlob: "bash",
      argPatternEntries: 1,
      expiresAt: null,
    });
    const text = JSON.stringify(rows);
    expect(text).not.toContain("SECRET-PATTERN");
    expect(text).not.toContain("NOTE-must-not-be-audited");
  });

  it("records a member revoking their own remember-rule in the team", async () => {
    const { rows: inserted } = await h.admin.query<{ id: string }>(
      `INSERT INTO tool_rules (team_id, scope, user_id, effect, tool_glob, created_by)
       VALUES ($1, 'user', $2, 'allow', 'read', $2) RETURNING id`,
      [finance, ids.alice],
    );
    const id = inserted[0]?.id ?? "";
    const rows = await recorded(() => alice.delete(`/v1/team/policy/my-rules/${id}`));
    expect(rows.map((r) => [r.action, r.team_id, r.actor_id, r.target.scope])).toEqual([
      ["policy.rule.deleted", finance, ids.alice, "user"],
    ]);
  });

  it("records moving a thread to Trash and restoring it, without its title", async () => {
    const created = await alice.post("/v1/threads", { title: "TITLE-must-not-be-audited" });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const threadId = created.json.thread_id as string;
    const rows = await recorded(async () => {
      await alice.delete(`/v1/threads/${threadId}`);
      await alice.delete(`/v1/threads/${threadId}`); // already in Trash: no second event
      await alice.post(`/v1/threads/${threadId}/restore`);
    });
    expect(rows.map((r) => [r.action, r.team_id, r.actor_id, r.target])).toEqual([
      ["thread.trashed", finance, ids.alice, { threadId }],
      ["thread.restored", finance, ids.alice, { threadId }],
    ]);
    expect(JSON.stringify(rows)).not.toContain("TITLE-must-not-be-audited");
  });
});

describe("audit and action commit together", () => {
  it("rolls the action back when its audit row can't be written", async () => {
    // Outside a request there is no actor: recordAudit throws inside the deactivation transaction.
    const mark = await head();
    await expect(deactivateUser(h.deps.database.db, ids.carol)).rejects.toThrow(/no actor/);
    const { rows } = await h.admin.query<{ deactivated_at: Date | null; sessions: number }>(
      `SELECT deactivated_at, (SELECT count(*)::int FROM sessions WHERE user_id = $1) AS sessions
       FROM users WHERE id = $1`,
      [ids.carol],
    );
    expect(rows[0]?.deactivated_at).toBeNull();
    expect(rows[0]?.sessions).toBeGreaterThan(0);
    expect(await since(mark)).toEqual([]);
  });

  it("commits both when the audit row is written", async () => {
    const asAdmin = { actor: { kind: "user" as const, id: ids.admin }, ip: null, userAgent: null };
    const rows = await recorded(async () => {
      await runWithAuditContext(asAdmin, () => deactivateUser(h.deps.database.db, ids.carol));
      await runWithAuditContext(asAdmin, () => reactivateUser(h.deps.database.db, ids.carol));
    });
    expect(rows.map((r) => [r.action, r.actor_id])).toEqual([
      ["identity.user.deactivated", ids.admin],
      ["identity.user.reactivated", ids.admin],
    ]);
  });
});

describe("read APIs", () => {
  it("limits the install log to install admins", async () => {
    expect((await alice.get("/v1/install/audit")).status).toBe(403);
    const page = await admin.get("/v1/install/audit?limit=5");
    expect(page.status).toBe(200);
    expect(page.json.events).toHaveLength(5);
    expect(typeof page.json.nextCursor).toBe("string");
    const next = await admin.get(`/v1/install/audit?limit=5&before=${page.json.nextCursor}`);
    expect(next.json.events[0].seq).toBeLessThan(page.json.events[4].seq);
    const auth = await admin.get("/v1/install/audit?category=auth&limit=200");
    expect(auth.json.events.every((e: { action: string }) => e.action.startsWith("auth."))).toBe(
      true,
    );
    expect((await admin.get("/v1/install/audit?limit=0")).status).toBe(400);
    expect((await admin.get("/v1/install/audit?bogus=1")).status).toBe(400);
  });

  it("shows team admins only their team's events, without IPs", async () => {
    const view = await alice.get("/v1/team/audit?limit=200");
    expect(view.status).toBe(200);
    const events = view.json.events as { teamId: string; action: string; ip: unknown }[];
    expect(events.length).toBeGreaterThan(5);
    expect(events.every((e) => e.teamId === finance && e.ip === null)).toBe(true);
    expect(events.map((e) => e.action)).toContain("identity.team.created");
    expect((await alice.get(`/v1/team/audit?teamId=${marketing}`)).status).toBe(400);

    const bob = await h.signIn(email("bob"), "another long password");
    await bob.put("/v1/me/teams/active", { teamId: marketing });
    const theirs = await bob.get("/v1/team/audit?limit=200");
    expect(theirs.json.events.length).toBeGreaterThan(0);
    expect(theirs.json.events.every((e: { teamId: string }) => e.teamId === marketing)).toBe(true);
  });

  it("refuses the team view to non-admins of the team", async () => {
    await alice.patch(`/v1/team/members/${ids.alice}`, { role: "team_admin" });
    const carol = await h.signIn(email("carol"), "a fresh new password");
    const inv = await alice.post("/v1/team/invites", { email: email("carol"), role: "builder" });
    expect(inv.status).toBe(202);
    await carol.post(`/v1/me/invites/${finance}/accept`);
    await carol.put("/v1/me/teams/active", { teamId: finance });
    expect((await carol.get("/v1/team/audit")).status).toBe(403);
  });

  it("verifies the hash chain over everything recorded", async () => {
    const res = await admin.get("/v1/install/audit/integrity");
    expect(res.json).toMatchObject({ ok: true, head: { seq: await head() } });
    expect((await alice.get("/v1/install/audit/integrity")).status).toBe(403);
  });
});

describe("what is recorded", () => {
  it("stores only allowlisted target fields: no secrets, tokens or content anywhere", async () => {
    const { rows } = await h.admin.query<{ action: string; target: Record<string, unknown> }>(
      `SELECT action, target FROM audit_log`,
    );
    for (const row of rows) {
      const allowed = Object.keys(
        (AUDIT_EVENTS as Record<string, { target: { shape: object } }>)[row.action]?.target.shape ??
          {},
      );
      expect(
        Object.keys(row.target).filter((k) => !allowed.includes(k)),
        row.action,
      ).toEqual([]);
    }
    const text = JSON.stringify(rows);
    for (const secret of [PASSWORD, "a fresh new password", "another long password", PROMPT]) {
      expect(text).not.toContain(secret);
    }
    const { rows: tokens } = await h.admin.query<{ token: string }>(
      `SELECT token FROM sessions UNION ALL SELECT token_hash FROM invitations`,
    );
    for (const { token } of tokens) expect(text).not.toContain(token);
    expect(await verifyAuditChain(h.deps.database.db)).toMatchObject({ ok: true });
  });
});

describe("isolation state changes", () => {
  it("records loss and restoration, not the normal boot, as system events", async () => {
    const observe = isolationAuditor(h.deps.database.db, "kobe-server-test");
    const at = new Date();
    const rows = await recorded(async () => {
      await observe({
        state: "verified",
        runtimeClassName: "gvisor",
        handler: "runsc",
        checkedAt: at,
      });
      await observe({
        state: "missing",
        runtimeClassName: "gvisor",
        message: "gone",
        checkedAt: at,
      });
      await observe({
        state: "missing",
        runtimeClassName: "gvisor",
        message: "gone",
        checkedAt: at,
      });
      await observe({
        state: "verified",
        runtimeClassName: "gvisor",
        handler: "runsc",
        checkedAt: at,
      });
    });
    expect(rows.map((r) => [r.action, r.actor_kind, r.actor_id, r.target])).toEqual([
      [
        "platform.isolation.changed",
        "system",
        null,
        { from: "verified", to: "missing", runtimeClass: "gvisor", replica: "kobe-server-test" },
      ],
      [
        "platform.isolation.changed",
        "system",
        null,
        {
          from: "missing",
          to: "verified",
          runtimeClass: "gvisor",
          handler: "runsc",
          replica: "kobe-server-test",
        },
      ],
    ]);
  });
});
