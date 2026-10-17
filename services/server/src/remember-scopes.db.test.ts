import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_REMEMBER_LIMITS, type RememberLimits } from "@kobe/protocol";
import { createDb, type KobeDatabase } from "@kobe/db";
import { approvalKeyring } from "./approvals/index.js";
import { createPolicyEngine } from "./policy/engine.js";
import { createToolRegistry } from "./policy/registry.js";
import { createDbRuleSource, createDbSettingsSource } from "./policy/rule-store.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";

/**
 * KOBE-289 end to end against Postgres and a real WebSocket sandbox: every remember scope is
 * enforced by the server (thread and run ids in evaluate; liveness of the thread and run in the
 * rule source), "until end of today" uses the stored time zone, "only this exact action" pins the
 * stored input, admin limits (team, and the site floor teams can only tighten) decide the choices
 * and apply at once to existing rules, "Approve all waiting" signs and audits each approval, a
 * call a rule allowed is announced and audited naming the rule, revocation is immediate (member
 * and team admin, never across teams), and scheduled and auto runs never use remembered rules.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
const sandboxes: FakeSandbox[] = [];
const extraDbs: KobeDatabase[] = [];
const KEY = approvalKeyring("approval-key-for-tests-".padEnd(48, "k"));
const registry = createToolRegistry();
let siteAdmin: Person;

beforeAll(async () => {
  await fx.setup([{}], () => {
    const database = createDb(fx.database.appUrl);
    extraDbs.push(database);
    return {
      approvalKeys: KEY,
      approvals: { pollMs: 100 },
      sandboxWire: {
        sweep: false,
        tools: registry,
        engine: createPolicyEngine({
          rules: createDbRuleSource(database.db),
          settings: createDbSettingsSource(database.db, 0),
          registry,
        }),
        tuning: { batchWindowMs: 20, resultPollMs: 200 },
      },
    };
  });
  listeners.push(await sandboxListener(fx.replica(0).deps, auth));
  siteAdmin = await fx.person("siteadmin");
  await fx.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [
    siteAdmin.id,
  ]);
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  for (const l of listeners) await l.close();
  await fx.teardown();
  for (const d of extraDbs) await d.close();
});

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly sandboxId: string;
  readonly sb: FakeSandbox;
}

interface Run {
  readonly runId: string;
  readonly threadId: string;
}

async function threadOf(teamId: string, runId: string): Promise<string> {
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [teamId, runId],
  );
  return must(rows[0], "run").thread_id;
}

async function world(members: readonly Person[] = []): Promise<World & Run> {
  const owner = await fx.person(`r${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`rs-${randomBytes(3).toString("hex")}`, owner, members);
  const sandboxId = randomUUID();
  const token = auth.issue({ sandboxId, teamId: team, userId: owner.id });
  const sb = await FakeSandbox.connect(must(listeners[0], "listener").url, token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId);
  await sb.ready();
  const w = { team, owner, sandboxId, sb };
  return { ...w, ...(await newRun(w)) };
}

/** A new run: in a new thread, or in `threadId` (after the previous run there ended). */
async function newRun(w: World, threadId?: string): Promise<Run> {
  let runId: string;
  if (threadId === undefined) {
    runId = await fx.run(w.team, w.owner);
  } else {
    const { rows } = await fx.admin.query<{ id: string }>(
      `INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, 'user', 'running', now()) RETURNING id`,
      [w.team, threadId],
    );
    runId = must(rows[0], "run").id;
  }
  const thread = await threadOf(w.team, runId);
  const started = await fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: w.team, userId: w.owner.id },
      { runId, threadId: thread, message: "hello" },
    );
  expect(started).toEqual({ ok: true });
  return { runId, threadId: thread };
}

async function endRun(w: World, run: Run): Promise<void> {
  await fx.complete(w.team, run.runId);
}

let nextRequest = 0;
function check(w: World, run: Run, tool: string, input: Record<string, unknown>) {
  const requestId = `q${(nextRequest += 1)}`;
  const toolCallId = `call-${requestId}`;
  w.sb.send({
    v: 1,
    type: "policy.check",
    request_id: requestId,
    run_id: run.runId,
    thread_id: run.threadId,
    tool_call_id: toolCallId,
    tool,
    input,
  });
  return {
    toolCallId,
    pending: () =>
      w.sb.until(() => w.sb.frames("policy.pending").find((f) => f.request_id === requestId)),
    result: () =>
      w.sb.until(() => w.sb.frames("policy.result").find((f) => f.request_id === requestId)),
  };
}

/** Asks, then answers it with `body`; returns the decision's response. */
async function approve(
  w: World,
  run: Run,
  tool: string,
  input: Record<string, unknown>,
  body: object,
) {
  const call = check(w, run, tool, input);
  const pending = await call.pending();
  const res = await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, body);
  return { res, call, approvalId: pending.approval_id };
}

/** The decision for one more call: "allow" (no asking) or "ask" (a card) — then answered deny. */
async function outcome(w: World, run: Run, tool: string, input: Record<string, unknown>) {
  const call = check(w, run, tool, input);
  const first = await w.sb.until(
    () =>
      w.sb.frames("policy.pending").find((f) => f.tool_call_id === call.toolCallId) ??
      w.sb.frames("policy.result").find((f) => f.tool_call_id === call.toolCallId),
  );
  if (first.type === "policy.result") return first.decision;
  await w.owner.browser.post(`/v1/approvals/${first.approval_id}`, { decision: "deny" });
  await call.result();
  return "ask";
}

const share = (path: string) => ({ path: `/workspace/${path}` });

async function events(teamId: string, runId: string) {
  const { rows } = await fx.admin.query<{ type: string; payload: Record<string, unknown> }>(
    `SELECT type, payload FROM run_events WHERE team_id = $1 AND run_id = $2 ORDER BY seq`,
    [teamId, runId],
  );
  return rows;
}

async function audits(teamId: string, action: string) {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
    [teamId, action],
  );
  return rows.map((r) => r.target);
}

async function rules(teamId: string) {
  const { rows } = await fx.admin.query<{
    id: string;
    remember_scope: string;
    thread_id: string | null;
    run_id: string | null;
    arg_pattern: Record<string, string> | null;
    expires_at: Date | null;
    last_used_at: Date | null;
  }>(
    `SELECT id, remember_scope, thread_id, run_id, arg_pattern, expires_at, last_used_at
       FROM tool_rules WHERE team_id = $1 AND scope = 'user' ORDER BY created_at`,
    [teamId],
  );
  return rows;
}

const limits = (over: Partial<RememberLimits>): RememberLimits => ({
  ...DEFAULT_REMEMBER_LIMITS,
  ...over,
});

describe("thread scope (this conversation)", () => {
  it("holds in its thread only, is announced and audited, and ends when the thread is archived", async () => {
    const w = await world();
    const { res } = await approve(w, w, "share_file", share("a.md"), {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "thread" },
    });
    expect(res.json).toMatchObject({ status: "allowed", remembered: true });
    const [rule] = await rules(w.team);
    expect(rule).toMatchObject({ remember_scope: "thread", thread_id: w.threadId, run_id: null });
    expect(rule?.expires_at).toBeNull();

    // Same thread: runs without asking, and the tool card and audit name the rule.
    const next = check(w, w, "share_file", share("b.md"));
    expect((await next.result()).decision).toBe("allow");
    const applied = (await events(w.team, w.runId)).find((e) => e.type === "policy.rule_applied");
    expect(applied?.payload).toEqual({
      tool_call_id: next.toolCallId,
      tool: "share_file",
      rule_id: rule?.id,
      scope: "thread",
    });
    expect(await audits(w.team, "policy.rule.applied")).toEqual([
      {
        ruleId: rule?.id,
        runId: w.runId,
        toolCallId: next.toolCallId,
        tool: "share_file",
        rememberScope: "thread",
        enforcementPoint: "sandbox",
      },
    ]);
    expect((await rules(w.team))[0]?.last_used_at).not.toBeNull();

    // Another thread of the same member still asks.
    const other = await newRun(w);
    expect(await outcome(w, other, "share_file", share("c.md"))).toBe("ask");

    // A later run in the same thread keeps it; archiving the thread ends it.
    await endRun(w, w);
    const again = await newRun(w, w.threadId);
    expect(await outcome(w, again, "share_file", share("d.md"))).toBe("allow");
    await fx.admin.query(`UPDATE threads SET archived_at = now() WHERE id = $1`, [w.threadId]);
    expect(await outcome(w, again, "share_file", share("e.md"))).toBe("ask");
    expect((await w.owner.browser.get("/v1/team/policy/my-rules")).json.rules).toEqual([]);
  });

  it("ends when the thread is deleted or moved to a project the member can't open", async () => {
    const w = await world();
    await approve(w, w, "share_file", share("a.md"), {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "thread" },
    });
    expect(await outcome(w, w, "share_file", share("b.md"))).toBe("allow");
    const project = randomUUID();
    await fx.admin.query(
      `INSERT INTO projects (team_id, id, slug, name, members_mode, created_by)
       VALUES ($1, $2, $3, 'Closed', 'selected', $4)`,
      [w.team, project, `p-${project.slice(0, 8)}`, w.owner.id],
    );
    // The owner is the team's admin (fx.team): demote them so the project is out of reach.
    await fx.admin.query(
      `UPDATE team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2`,
      [w.team, w.owner.id],
    );
    await fx.admin.query(`UPDATE threads SET project_id = $2 WHERE id = $1`, [w.threadId, project]);
    expect(await outcome(w, w, "share_file", share("c.md"))).toBe("ask");
    await fx.admin.query(`UPDATE threads SET project_id = NULL WHERE id = $1`, [w.threadId]);
    expect(await outcome(w, w, "share_file", share("d.md"))).toBe("allow");
    await fx.admin.query(`UPDATE threads SET deleted_at = now() WHERE id = $1`, [w.threadId]);
    expect(await outcome(w, w, "share_file", share("e.md"))).toBe("ask");
  });
});

describe("run scope (this run only)", () => {
  it("holds in its run only", async () => {
    const w = await world();
    await approve(w, w, "share_file", share("a.md"), {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "run" },
    });
    expect(await rules(w.team)).toEqual([
      expect.objectContaining({ remember_scope: "run", run_id: w.runId, thread_id: null }),
    ]);
    expect(await outcome(w, w, "share_file", share("b.md"))).toBe("allow");
    await endRun(w, w);
    const later = await newRun(w, w.threadId);
    expect(await outcome(w, later, "share_file", share("c.md"))).toBe("ask");
    // The ended run's rule is pruned (audited, by the system) when the member makes a new one.
    const [old] = await rules(w.team);
    await approve(w, later, "share_file", share("d.md"), {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "run" },
    });
    expect((await rules(w.team)).map((r) => r.run_id)).toEqual([later.runId]);
    const { rows } = await fx.admin.query<{ actor_kind: string; target: { ruleId: string } }>(
      `SELECT actor_kind::text, target FROM audit_log
        WHERE team_id = $1 AND action = 'policy.rule.deleted' ORDER BY seq`,
      [w.team],
    );
    expect(rows).toEqual([
      { actor_kind: "system", target: expect.objectContaining({ ruleId: old?.id }) },
    ]);
  });
});

describe("until end of today", () => {
  it("expires at midnight in the member's stored time zone", async () => {
    const w = await world();
    expect((await w.owner.browser.put("/v1/me/time-zone", { time_zone: "Not/AZone" })).status).toBe(
      400,
    );
    expect(
      (await w.owner.browser.put("/v1/me/time-zone", { time_zone: "Pacific/Kiritimati" })).json,
    ).toEqual({ time_zone: "Pacific/Kiritimati" });
    const call = check(w, w, "share_file", share("a.md"));
    const pending = await call.pending();
    const options = await w.owner.browser.get(`/v1/approvals/${pending.approval_id}/remember`);
    const today = options.json.choices.find((c: { scope: string }) => c.scope === "today");
    expect(options.json.time_zone).toBe("Pacific/Kiritimati");
    const res = await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "today" },
    });
    expect(res.status).toBe(200);
    const expires = must((await rules(w.team))[0]?.expires_at, "expiry");
    // Midnight at UTC+14 is 10:00 UTC; the card showed the same instant before saving.
    expect(expires.getUTCHours()).toBe(10);
    expect(expires.getUTCMinutes()).toBe(0);
    expect(expires.getTime()).toBeGreaterThan(Date.now());
    expect(expires.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    expect(Math.abs(Date.parse(today.expires_at) - expires.getTime())).toBeLessThan(5_000);
  });
});

describe("only this exact action", () => {
  it("is derived from the stored input, shown first, and allows exactly that action", async () => {
    const w = await world();
    const call = check(w, w, "share_file", { path: "reports/../q3*.md" });
    const pending = await call.pending();
    const options = await w.owner.browser.get(`/v1/approvals/${pending.approval_id}/remember`);
    expect(options.json.exact).toEqual({ arg_pattern: { "/path": "/workspace/q3\\*.md" } });
    const res = await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "forever", exact: true },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await rules(w.team))[0]?.arg_pattern).toEqual({ "/path": "/workspace/q3\\*.md" });
    expect(await outcome(w, w, "share_file", { path: "/workspace/q3*.md" })).toBe("allow");
    // A glob character is literal: q3x.md is another action.
    expect(await outcome(w, w, "share_file", { path: "/workspace/q3x.md" })).toBe("ask");
  });

  it("refuses a client-chosen pattern and too broad a tool glob", async () => {
    const w = await world();
    const call = check(w, w, "share_file", share("a.md"));
    const pending = await call.pending();
    const id = pending.approval_id;
    const sent = (remember: object) =>
      w.owner.browser.post(`/v1/approvals/${id}`, { decision: "allow", remember });
    expect(
      (await sent({ tool_glob: "share_file", scope: "day", arg_pattern: { "/path": "*" } })).json,
    ).toMatchObject({ code: "invalid_request" });
    expect((await sent({ tool_glob: "share_*", scope: "day" })).json).toMatchObject({
      code: "glob_too_broad",
    });
    expect(await rules(w.team)).toEqual([]);
  });
});

describe("admin limits", () => {
  it("the card offers only allowed choices, the server refuses others, and tightening applies at once", async () => {
    const w = await world();
    // An existing until-revoked rule from before the limits.
    await approve(w, w, "share_file", share("a.md"), {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "forever" },
    });
    expect(await outcome(w, w, "share_file", share("b.md"))).toBe("allow");

    const put = await w.owner.browser.put(
      "/v1/team/policy/remember-limits",
      limits({ scopes: ["thread", "run", "today"], approve_all: false }),
    );
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json.effective.scopes).toEqual(["thread", "today", "run"]);
    // The until-revoked rule stops applying at once.
    expect(await outcome(w, w, "share_file", share("c.md"))).toBe("ask");

    const call = check(w, w, "remember", { scope: "project", path: "notes.md", content: "x" });
    const pending = await call.pending();
    const options = await w.owner.browser.get(`/v1/approvals/${pending.approval_id}/remember`);
    expect(options.json.choices.map((c: { scope: string }) => c.scope)).toEqual([
      "thread",
      "today",
      "run",
    ]);
    const refused = await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, {
      decision: "allow",
      remember: { tool_glob: "remember", scope: "month" },
    });
    expect(refused).toMatchObject({ status: 403, json: { code: "remember_not_allowed" } });
    await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, { decision: "deny" });
    expect(await audits(w.team, "policy.remember_limits.updated")).toEqual([
      expect.objectContaining({ scope: "team", approveAll: false }),
    ]);
  });

  it("the site floor binds every team, and a team can only tighten it", async () => {
    const w = await world();
    const floor = limits({ scopes: ["thread", "run"], max_duration_seconds: 3600 });
    expect((await siteAdmin.browser.put("/v1/site/policy/remember-limits", floor)).status).toBe(
      200,
    );
    try {
      const looser = await w.owner.browser.put("/v1/team/policy/remember-limits", limits({}));
      expect(looser).toMatchObject({ status: 400, json: { code: "limits_above_floor" } });
      expect(looser.json.fields).toEqual(["scopes", "max_duration_seconds"]);
      const read = await w.owner.browser.get("/v1/team/policy/remember-limits");
      expect(read.json.effective).toMatchObject({
        scopes: ["thread", "run"],
        max_duration_seconds: 3600,
      });
      // Members (not admins) can read the limits but never change them.
      const call = check(w, w, "share_file", share("a.md"));
      const pending = await call.pending();
      const refused = await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, {
        decision: "allow",
        remember: { tool_glob: "share_file", scope: "day" },
      });
      expect(refused.json).toMatchObject({ code: "remember_not_allowed" });
      const ok = await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, {
        decision: "allow",
        remember: { tool_glob: "share_file", scope: "thread" },
      });
      expect(ok.status).toBe(200);
      // Capped by the floor's max duration even though threads have no time of their own.
      const expires = must((await rules(w.team))[0]?.expires_at, "expiry");
      expect(expires.getTime() - Date.now()).toBeLessThanOrEqual(3600_000);
    } finally {
      await siteAdmin.browser.put("/v1/site/policy/remember-limits", DEFAULT_REMEMBER_LIMITS);
    }
  });

  it("members can't set limits", async () => {
    const member = await fx.person(`m${randomBytes(2).toString("hex")}`);
    const w = await world([member]);
    expect((await member.browser.put("/v1/team/policy/remember-limits", limits({}))).status).toBe(
      403,
    );
    expect((await member.browser.get("/v1/team/policy/remember-limits")).status).toBe(200);
    expect((await member.browser.get("/v1/site/policy/remember-limits")).status).toBe(403);
    void w;
  });
});

describe("approve all waiting", () => {
  it("allows every waiting approval of the run, each signed and audited on its own", async () => {
    const w = await world();
    const a = check(w, w, "share_file", share("a.md"));
    const b = check(w, w, "share_file", share("b.md"));
    const [pa, pb] = [await a.pending(), await b.pending()];
    const options = await w.owner.browser.get(`/v1/approvals/${pa.approval_id}/remember`);
    expect(options.json.approve_all.approval_ids).toEqual([pa.approval_id, pb.approval_id].sort());
    const res = await w.owner.browser.post("/v1/approvals/approve-all", {
      run_id: w.runId,
      approval_ids: [pa.approval_id, pb.approval_id],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.approvals.map((x: { status: string }) => x.status)).toEqual([
      "allowed",
      "allowed",
    ]);
    expect((await a.result()).decision).toBe("allow");
    expect((await b.result()).decision).toBe("allow");
    const { rows } = await fx.admin.query<{ id: string; input_hmac: string }>(
      `SELECT id, input_hmac FROM approvals WHERE run_id = $1 ORDER BY id`,
      [w.runId],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.input_hmac)).size).toBe(2);
    const decided = await audits(w.team, "approval.decided");
    expect(decided).toHaveLength(2);
    for (const d of decided) expect(d).toMatchObject({ decision: "allow", approveAll: true });
    expect(
      (await events(w.team, w.runId)).filter((e) => e.type === "approval.resolved"),
    ).toHaveLength(2);
    await expect
      .poll(
        async () =>
          (await fx.admin.query(`SELECT status FROM runs WHERE id = $1`, [w.runId])).rows[0]
            ?.status,
      )
      .toBe("running");
  });

  it("is refused when any is destructive, by the team's limits, and for anyone else", async () => {
    const reader = await fx.person(`v${randomBytes(2).toString("hex")}`);
    const w = await world([reader]);
    const ask = await w.owner.browser.post("/v1/team/policy/rules", {
      effect: "ask",
      tool_glob: "bash",
    });
    expect(ask.status).toBe(201);
    const a = check(w, w, "share_file", share("a.md"));
    const b = check(w, w, "bash", { command: "ls" });
    const ids = [(await a.pending()).approval_id, (await b.pending()).approval_id];
    const options = await w.owner.browser.get(`/v1/approvals/${ids[0]}/remember`);
    expect(options.json.approve_all).toBeNull();
    const body = { run_id: w.runId, approval_ids: ids };
    expect(await w.owner.browser.post("/v1/approvals/approve-all", body)).toMatchObject({
      status: 403,
      json: { code: "approve_all_not_allowed" },
    });
    // A reader of the thread shared to the team can never decide it (404, as before).
    await fx.admin.query(`UPDATE threads SET shared_to_team = true WHERE id = $1`, [w.threadId]);
    expect((await reader.browser.post("/v1/approvals/approve-all", body)).status).toBe(404);
    expect((await reader.browser.get(`/v1/approvals/${ids[0]}/remember`)).status).toBe(404);
    expect(
      (await reader.browser.post(`/v1/approvals/${ids[0]}`, { decision: "allow" })).status,
    ).toBe(404);
    // Nothing was approved.
    const { rows } = await fx.admin.query(`SELECT status FROM approvals WHERE run_id = $1`, [
      w.runId,
    ]);
    expect(rows.map((r) => r.status)).toEqual(["pending", "pending"]);
    for (const id of ids) await w.owner.browser.post(`/v1/approvals/${id}`, { decision: "deny" });

    await w.owner.browser.put("/v1/team/policy/remember-limits", limits({ approve_all: false }));
    const c = check(w, w, "share_file", share("c.md"));
    const d = check(w, w, "share_file", share("d.md"));
    const more = [(await c.pending()).approval_id, (await d.pending()).approval_id];
    expect(
      await w.owner.browser.post("/v1/approvals/approve-all", {
        run_id: w.runId,
        approval_ids: more,
      }),
    ).toMatchObject({ status: 403, json: { code: "approve_all_not_allowed" } });
  });
});

describe("revocation and visibility", () => {
  it("a member's revoke and a team admin's revoke take effect at once, never across teams", async () => {
    const member = await fx.person(`m${randomBytes(2).toString("hex")}`);
    const w = await world();
    const other = await world();
    await approve(w, w, "share_file", share("a.md"), {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "forever" },
    });
    const mine = await w.owner.browser.get("/v1/team/policy/my-rules");
    expect(mine.json.rules).toEqual([
      expect.objectContaining({
        tool_glob: "share_file",
        remember_scope: "forever",
        user_id: w.owner.id,
      }),
    ]);
    const ruleId = mine.json.rules[0].id as string;
    // The admin of another team can't see or revoke it.
    expect((await other.owner.browser.get("/v1/team/policy/member-rules")).json.rules).toEqual([]);
    expect(
      (await other.owner.browser.delete(`/v1/team/policy/member-rules/${ruleId}`)).status,
    ).toBe(404);
    // A member who is not an admin can't list members' rules.
    await fx.addMember(w.team, member);
    await fx.activate(member, w.team);
    expect((await member.browser.get("/v1/team/policy/member-rules")).status).toBe(403);
    expect((await member.browser.delete(`/v1/team/policy/my-rules/${ruleId}`)).status).toBe(404);
    // The team admin sees it and revokes it: the next call asks.
    const listed = await w.owner.browser.get("/v1/team/policy/member-rules");
    expect(listed.json.rules.map((r: { id: string }) => r.id)).toEqual([ruleId]);
    expect(await outcome(w, w, "share_file", share("b.md"))).toBe("allow");
    expect((await w.owner.browser.delete(`/v1/team/policy/member-rules/${ruleId}`)).status).toBe(
      204,
    );
    expect(await outcome(w, w, "share_file", share("c.md"))).toBe("ask");
    expect(await audits(w.team, "policy.rule.deleted")).toEqual([
      expect.objectContaining({ ruleId, scope: "user", rememberScope: "forever" }),
    ]);
  });

  it("scheduled and auto runs ignore remembered rules: denied, never queued", async () => {
    const w = await world();
    await approve(w, w, "share_file", share("a.md"), {
      decision: "allow",
      remember: { tool_glob: "share_file", scope: "thread" },
    });
    expect(await outcome(w, w, "share_file", share("b.md"))).toBe("allow");
    await endRun(w, w);
    for (const update of [
      `UPDATE runs SET trigger = 'schedule' WHERE id = $1`,
      `UPDATE runs SET approval_mode = 'auto' WHERE id = $1`,
    ]) {
      const run = await newRun(w, w.threadId);
      await fx.admin.query(update, [run.runId]);
      const call = check(w, run, "share_file", share("c.md"));
      const result = await call.result();
      expect(result.decision).toBe("deny");
      const { rows } = await fx.admin.query(`SELECT 1 FROM approvals WHERE run_id = $1`, [
        run.runId,
      ]);
      expect(rows).toHaveLength(0);
      await endRun(w, run);
    }
  });
});
