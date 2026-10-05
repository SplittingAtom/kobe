import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APPROVAL_TTL_MS,
  canonicalJson,
  type PolicyInput,
  type ToolDescriptor,
} from "@kobe/protocol";
import { createDb, type KobeDatabase } from "@kobe/db";
import { APPROVALS_MAX_PER_RUN, approvalKeyring, enforceMcpCall } from "./approvals/index.js";
import { createPolicyEngine } from "./policy/engine.js";
import { createToolRegistry } from "./policy/registry.js";
import { createDbRuleSource, createDbSettingsSource } from "./policy/rule-store.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";

/**
 * Approvals (KOBE-37, D29) end to end against Postgres, real WebSockets and two replicas: a
 * policy rule makes a tool call wait for its user; allow / deny / remember through the API on the
 * other replica; who may decide; TTL expiry ends the run; Stop, budget and a lost connection
 * expire the approval; the tool call id can't be replayed; and Gate 2 — the MCP proxy's
 * verify-and-consume seam refuses every call a tampered kobe-policy could make without a valid
 * signed approval for exactly that input.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
const sandboxes: FakeSandbox[] = [];
const extraDbs: KobeDatabase[] = [];
/** A small run event cap so the cap test reaches it (every other test stays far below). */
const RUN_MAX_EVENTS = 40;
const KEY = approvalKeyring("approval-key-for-tests-".padEnd(48, "k"));
/** Shifts every approval clock (TTL, token expiry) forward in tests. */
let skewMs = 0;
const now = () => new Date(Date.now() + skewMs);

const CONNECTOR = "55555555-5555-4555-8555-555555555555";
const mcpTool = (name: string, risk: ToolDescriptor["risk"]): ToolDescriptor => ({
  name,
  source: "mcp",
  connector_id: CONNECTOR,
  risk,
  open_world: true,
  scope: "external",
});
const CATALOG = {
  resolve: (_team: string, name: string) =>
    Promise.resolve(
      name === "mcp__jira__create_issue"
        ? mcpTool(name, "write")
        : name === "mcp__jira__delete_issue"
          ? mcpTool(name, "destructive")
          : undefined,
    ),
};
const CONNECTORS = {
  get: () =>
    Promise.resolve({
      enabled: true,
      exposure: "all" as const,
      enabled_tools: [],
      drifted_tools: [],
    }),
};
const registry = createToolRegistry(CATALOG);

beforeAll(async () => {
  await fx.setup([{}, {}], () => {
    const database = createDb(fx.database.appUrl);
    extraDbs.push(database);
    return {
      approvalKeys: KEY,
      approvals: { now, pollMs: 100, runMaxEvents: RUN_MAX_EVENTS },
      sandboxWire: {
        sweep: false,
        tools: registry,
        engine: createPolicyEngine({
          rules: createDbRuleSource(database.db),
          settings: createDbSettingsSource(database.db, 0),
          registry,
          connectors: CONNECTORS,
        }),
        tuning: {
          batchWindowMs: 20,
          resultPollMs: 200,
          upgradeBurst: 1_000,
          upgradeRatePerSec: 100,
        },
      },
    };
  });
  listeners.push(await sandboxListener(fx.replica(0).deps, auth));
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
  readonly runId: string;
  readonly threadId: string;
  readonly sb: FakeSandbox;
}

async function threadOf(teamId: string, runId: string): Promise<string> {
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [teamId, runId],
  );
  return must(rows[0], "run").thread_id;
}

/** A team, its owner, a running run started on the owner's (fake) sandbox on replica 0. */
async function world(members: readonly Person[] = []): Promise<World> {
  const owner = await fx.person(`a${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`ap-${randomBytes(3).toString("hex")}`, owner, members);
  const runId = await fx.run(team, owner);
  const threadId = await threadOf(team, runId);
  const sandboxId = randomUUID();
  const token = auth.issue({ sandboxId, teamId: team, userId: owner.id });
  const sb = await FakeSandbox.connect(must(listeners[0], "listener").url, token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId);
  await sb.ready();
  const started = await fx
    .replica(1)
    .deps.sandboxWire.router.startRun(
      { teamId: team, userId: owner.id },
      { runId, threadId, message: "hello" },
    );
  expect(started).toEqual({ ok: true });
  return { team, owner, runId, threadId, sb };
}

let nextRequest = 0;
function check(w: World, tool: string, input: Record<string, unknown>, toolCallId?: string) {
  const requestId = `r${(nextRequest += 1)}`;
  w.sb.send({
    v: 1,
    type: "policy.check",
    request_id: requestId,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: toolCallId ?? `call-${requestId}`,
    tool,
    input,
  });
  return {
    requestId,
    pending: () =>
      w.sb.until(() => w.sb.frames("policy.pending").find((f) => f.request_id === requestId)),
    result: () =>
      w.sb.until(() => w.sb.frames("policy.result").find((f) => f.request_id === requestId)),
  };
}

async function askRule(w: World, toolGlob: string): Promise<void> {
  const res = await w.owner.browser.post("/v1/team/policy/rules", {
    effect: "ask",
    tool_glob: toolGlob,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
}

async function decide(p: Person, approvalId: string, body: object, replica = 1) {
  // The decision arrives on the other replica than the one holding the sandbox (bus hint).
  const headers = {
    cookie: [...p.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    origin: "http://kobe.test",
    "content-type": "application/json",
    "x-forwarded-for": p.browser.ip,
    ...(p.browser.team ? { "x-kobe-team": p.browser.team } : {}),
  };
  const res = await fx.replica(replica).app.request(`http://kobe.test/v1/approvals/${approvalId}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function events(teamId: string, runId: string) {
  const { rows } = await fx.admin.query<{ type: string; payload: Record<string, unknown> }>(
    `SELECT type, payload FROM run_events WHERE team_id = $1 AND run_id = $2 ORDER BY seq`,
    [teamId, runId],
  );
  return rows;
}

async function runStatus(teamId: string, runId: string): Promise<string> {
  const { rows } = await fx.admin.query<{ status: string }>(
    `SELECT status FROM runs WHERE team_id = $1 AND id = $2`,
    [teamId, runId],
  );
  return must(rows[0], "run").status;
}

async function approvalRow(id: string) {
  const { rows } = await fx.admin.query<{
    status: string;
    cause: string | null;
    input_hmac: string | null;
    consumed_at: Date | null;
    remembered: boolean;
  }>(`SELECT status, cause, input_hmac, consumed_at, remembered FROM approvals WHERE id = $1`, [
    id,
  ]);
  return must(rows[0], "approval");
}

async function audits(teamId: string, prefix: string) {
  const { rows } = await fx.admin.query<{ action: string; target: Record<string, unknown> }>(
    `SELECT action, target FROM audit_log WHERE team_id = $1 AND action LIKE $2 ORDER BY seq`,
    [teamId, `${prefix}%`],
  );
  return rows;
}

describe("defaults (user decision 2026-10-03)", () => {
  it("never prompts for sandbox tools unless a policy rule asks", async () => {
    const w = await world();
    for (const [tool, input] of [
      ["bash", { command: "rm -rf build" }],
      ["write", { path: "a.txt", content: "x" }],
      ["edit", { path: "a.txt", edits: [{ oldText: "x", newText: "y" }] }],
    ] as const) {
      expect((await check(w, tool, input).result()).decision).toBe("allow");
    }
    expect(w.sb.frames("policy.pending")).toHaveLength(0);
    await askRule(w, "bash");
    const asked = check(w, "bash", { command: "ls" });
    expect((await asked.pending()).approval_id).toMatch(/^[0-9a-f-]{36}$/);
    // A write without a rule still runs.
    expect((await check(w, "write", { path: "b.txt", content: "y" }).result()).decision).toBe(
      "allow",
    );
  });
});

describe("a policy rule makes the call wait for its user", () => {
  it("allow: pending → card event → API on another replica → signed allow; run resumes; audited", async () => {
    const w = await world();
    await askRule(w, "bash");
    const call = check(w, "bash", { command: "make deploy", timeout: 30 });
    const pending = await call.pending();
    expect(await runStatus(w.team, w.runId)).toBe("waiting_approval");
    const requested = (await events(w.team, w.runId)).find((e) => e.type === "approval.requested");
    expect(requested?.payload).toMatchObject({
      approval_id: pending.approval_id,
      tool: "bash",
      input: { command: "make deploy", timeout: 30 },
      risk: "destructive",
      reasons: [{ code: "team_ask_rule" }],
    });
    // The card can read it back (owner only).
    const view = await w.owner.browser.get(`/v1/approvals/${pending.approval_id}`);
    expect(view.status).toBe(200);
    expect(view.json).toMatchObject({
      status: "pending",
      tool: "bash",
      input: { command: "make deploy" },
    });
    const listed = await w.owner.browser.get(`/v1/approvals?status=pending&run_id=${w.runId}`);
    expect(listed.json.approvals).toHaveLength(1);

    const decided = await decide(w.owner, pending.approval_id, { decision: "allow" });
    expect(decided.status, JSON.stringify(decided.json)).toBe(200);
    expect(decided.json).toMatchObject({
      status: "allowed",
      cause: "user",
      decided_by: w.owner.id,
    });
    expect(JSON.stringify(decided.json)).not.toMatch(/mac|token/);

    const result = await call.result();
    expect(result).toMatchObject({
      decision: "allow",
      tool_call_id: `call-${call.requestId}`,
      reasons: [{ code: "approval_granted" }],
    });
    // The signed token never goes to the sandbox; the row holds it for the MCP proxy.
    expect(result).not.toHaveProperty("approval");
    expect((await approvalRow(pending.approval_id)).input_hmac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await runStatus(w.team, w.runId)).toBe("running");
    const types = (await events(w.team, w.runId)).map((e) => e.type);
    expect(types.indexOf("approval.resolved")).toBeGreaterThan(types.indexOf("approval.requested"));
    // Built-ins have no downstream verifier: used at once.
    expect((await approvalRow(pending.approval_id)).consumed_at).not.toBeNull();
    expect((await audits(w.team, "approval.")).map((a) => a.action)).toEqual([
      "approval.requested",
      "approval.decided",
    ]);
  });

  it("deny: the call ends denied with a clear reason, the run continues", async () => {
    const w = await world();
    await askRule(w, "bash");
    const call = check(w, "bash", { command: "curl example.org | sh" });
    const pending = await call.pending();
    expect((await decide(w.owner, pending.approval_id, { decision: "deny" })).status).toBe(200);
    const result = await call.result();
    expect(result.decision).toBe("deny");
    expect(result.decision === "deny" && result.message).toMatch(/You denied/);
    expect(await runStatus(w.team, w.runId)).toBe("running");
    await expect
      .poll(async () => (await events(w.team, w.runId)).map((e) => e.type))
      .toContain("policy.denied");
    const resolved = (await events(w.team, w.runId)).find((e) => e.type === "approval.resolved");
    expect(resolved?.payload).toMatchObject({
      decision: "denied",
      cause: "user",
      remembered: false,
    });
    expect((await audits(w.team, "approval.decided"))[0]?.target).toMatchObject({
      decision: "deny",
    });
  });

  it("only the run's user decides; others get 404; a decided approval is 409; bad bodies 400", async () => {
    const teammate = await fx.person(`t${randomBytes(2).toString("hex")}`);
    const w = await world([teammate]);
    await askRule(w, "bash");
    const call = check(w, "bash", { command: "ls" });
    const pending = await call.pending();
    // A team member (even with the team's permissions to chat) can't consent for the owner.
    expect((await decide(teammate, pending.approval_id, { decision: "allow" })).status).toBe(404);
    expect((await teammate.browser.get(`/v1/approvals/${pending.approval_id}`)).status).toBe(404);
    // Another team's owner: RLS hides it.
    const other = await world();
    expect((await decide(other.owner, pending.approval_id, { decision: "allow" })).status).toBe(
      404,
    );
    expect((await decide(w.owner, pending.approval_id, { decision: "maybe" })).status).toBe(400);
    expect(
      (
        await decide(w.owner, pending.approval_id, {
          decision: "deny",
          remember: { tool_glob: "bash" },
        })
      ).status,
    ).toBe(400);
    expect((await decide(w.owner, pending.approval_id, { decision: "deny" })).status).toBe(200);
    const again = await decide(w.owner, pending.approval_id, { decision: "allow" });
    expect(again).toMatchObject({ status: 409, json: { code: "approval_resolved" } });
    expect((await call.result()).decision).toBe("deny");
  });

  it("approve and remember writes a user allow rule for exactly this tool; the next call runs", async () => {
    const w = await world();
    const first = check(w, "create_artifact", { kind: "markdown", title: "Q3", content: "x" });
    const pending = await first.pending();
    expect(
      (
        await decide(w.owner, pending.approval_id, {
          decision: "allow",
          remember: { tool_glob: "mcp__*" },
        })
      ).json,
    ).toMatchObject({ code: "glob_too_broad" });
    const ok = await decide(w.owner, pending.approval_id, {
      decision: "allow",
      remember: { tool_glob: "create_artifact", expires_in: 3600 },
    });
    expect(ok.json).toMatchObject({ status: "allowed", remembered: true });
    expect((await first.result()).decision).toBe("allow");
    const { rows } = await fx.admin.query(
      `SELECT scope, user_id, effect, tool_glob, expires_at FROM tool_rules WHERE team_id = $1`,
      [w.team],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        scope: "user",
        user_id: w.owner.id,
        effect: "allow",
        tool_glob: "create_artifact",
      }),
    ]);
    expect(must(rows[0], "rule").expires_at).not.toBeNull();
    // Remembered: the next create_artifact runs without asking.
    expect(
      (await check(w, "create_artifact", { kind: "markdown", title: "Q4", content: "x" }).result())
        .decision,
    ).toBe("allow");
    const decidedAudit = (await audits(w.team, "approval.decided"))[0]?.target;
    expect(decidedAudit).toMatchObject({ remember: true, ruleId: expect.any(String) });
    expect((await audits(w.team, "policy.rule.created")).length).toBe(1);
    // A remember-rule never lifts an ask rule.
    await askRule(w, "create_artifact");
    expect(
      (await check(w, "create_artifact", { kind: "markdown", title: "Q5", content: "x" }).pending())
        .approval_id,
    ).toBeTruthy();
  });

  it("a replayed tool_call_id can't ask again in the same run", async () => {
    const w = await world();
    await askRule(w, "bash");
    const first = check(w, "bash", { command: "ls" }, "same-id");
    const pending = await first.pending();
    const replay = check(w, "bash", { command: "rm -rf /" }, "same-id");
    const result = await replay.result();
    expect(result.decision === "deny" && result.message).toMatch(/already asked/);
    await decide(w.owner, pending.approval_id, { decision: "deny" });
    await first.result();
  });
});

describe("review: abuse limits, replay audit, undeliverable decisions", () => {
  it("audits a replayed tool_call_id as a tamper signal", async () => {
    const w = await world();
    await askRule(w, "bash");
    const first = check(w, "bash", { command: "ls" }, "dup-id");
    const pending = await first.pending();
    await check(w, "bash", { command: "rm -rf /" }, "dup-id").result();
    expect((await audits(w.team, "approval.rejected"))[0]?.target).toMatchObject({
      reason: "replayed_tool_call_id",
      enforcementPoint: "server",
      toolCallId: "dup-id",
    });
    await decide(w.owner, pending.approval_id, { decision: "deny" });
  });

  it(`caps approvals per run (${APPROVALS_MAX_PER_RUN})`, async () => {
    const w = await world();
    await askRule(w, "bash");
    // Earlier approvals of the run, as if a looping sandbox had asked them.
    await fx.admin.query(
      `INSERT INTO approvals (team_id, run_id, thread_id, user_id, connection_id, tool_call_id,
                              tool, input_canonical, risk, reasons, status, cause, decided_at,
                              expires_at)
       SELECT $1, $2, $3, $4, gen_random_uuid(), 'old-' || n, 'bash', '{}', 'write', '[]',
              'expired', 'run_interrupted', now(), now()
         FROM generate_series(1, $5::int) n`,
      [w.team, w.runId, w.threadId, w.owner.id, APPROVALS_MAX_PER_RUN],
    );
    const result = await check(w, "bash", { command: "ls" }).result();
    expect(result.decision === "deny" && result.message).toMatch(/already asked for 100/);
    expect((await audits(w.team, "approval.rejected"))[0]?.target).toMatchObject({
      reason: "too_many_approvals",
    });
    expect(await runStatus(w.team, w.runId)).toBe("running");
  });

  it("stops asking once the run nears its event cap", async () => {
    const w = await world();
    await askRule(w, "bash");
    let denied = "";
    for (let i = 0; i < RUN_MAX_EVENTS; i += 1) {
      const call = check(w, "bash", { command: `echo ${i}` });
      const first = await w.sb.until(
        () =>
          w.sb.frames("policy.pending").find((f) => f.request_id === call.requestId) ??
          w.sb.frames("policy.result").find((f) => f.request_id === call.requestId),
      );
      if (first.type === "policy.result") {
        denied = first.decision === "deny" ? first.message : "";
        break;
      }
      await decide(w.owner, first.approval_id, { decision: "deny" });
      await call.result();
    }
    expect(denied).toMatch(/event limit/);
    expect((await audits(w.team, "approval.rejected")).at(-1)?.target).toMatchObject({
      reason: "run_event_cap",
    });
  });

  it("refuses a decision once the connection that asked is gone, and expires the approval", async () => {
    const w = await world();
    await askRule(w, "bash");
    const call = check(w, "bash", { command: "make deploy" });
    const pending = await call.pending();
    // The asking connection is no longer the sandbox's (e.g. its replica died).
    await fx.admin.query(
      `UPDATE sandbox_connections SET connection_id = gen_random_uuid() WHERE team_id = $1`,
      [w.team],
    );
    const refused = await decide(w.owner, pending.approval_id, { decision: "allow" });
    expect(refused).toMatchObject({ status: 409, json: { code: "approval_unavailable" } });
    expect(await approvalRow(pending.approval_id)).toMatchObject({
      status: "expired",
      cause: "run_interrupted",
      input_hmac: null,
    });
    expect(await runStatus(w.team, w.runId)).toBe("running");
    expect((await call.result()).decision).toBe("deny");
  });

  it("voids an allowed MCP approval whose allow never reached the sandbox", async () => {
    const w = await world();
    const call = check(w, "mcp__jira__create_issue", { project: "OPS" }, "tc-void");
    const pending = await call.pending();
    expect((await decide(w.owner, pending.approval_id, { decision: "allow" })).status).toBe(200);
    await call.result();
    // As if the connection had closed before the allow was delivered.
    await fx.replica(0).deps.approvals.abandon(w.team, pending.approval_id);
    expect(await approvalRow(pending.approval_id)).toMatchObject({
      status: "expired",
      cause: "run_interrupted",
      input_hmac: null,
    });
    expect(
      await fx.replica(1).deps.approvals.verifier.authorize({
        teamId: w.team,
        userId: w.owner.id,
        runId: w.runId,
        toolCallId: "tc-void",
        tool: "mcp__jira__create_issue",
        input: { project: "OPS" },
      }),
    ).toEqual({ ok: false, reason: "not_allowed" });
    const resolved = (await events(w.team, w.runId)).filter((e) => e.type === "approval.resolved");
    expect(resolved.at(-1)?.payload).toMatchObject({
      decision: "expired",
      cause: "run_interrupted",
    });
  });

  it("keeps a consumed MCP approval as used (it ran through the proxy)", async () => {
    const w = await world();
    const call = check(w, "mcp__jira__create_issue", { project: "OPS" }, "tc-used");
    const pending = await call.pending();
    await decide(w.owner, pending.approval_id, { decision: "allow" });
    await call.result();
    const base = {
      teamId: w.team,
      userId: w.owner.id,
      runId: w.runId,
      toolCallId: "tc-used",
      tool: "mcp__jira__create_issue",
      input: { project: "OPS" },
    };
    expect((await fx.replica(1).deps.approvals.verifier.authorize(base)).ok).toBe(true);
    await fx.replica(0).deps.approvals.abandon(w.team, pending.approval_id);
    expect((await approvalRow(pending.approval_id)).status).toBe("allowed");
  });

  it("audits each forged tool call id at the proxy (not one row per run)", async () => {
    const w = await world();
    const verifier = fx.replica(1).deps.approvals.verifier;
    const base = {
      teamId: w.team,
      userId: w.owner.id,
      runId: w.runId,
      tool: "mcp__jira__create_issue",
      input: {},
    };
    for (const id of ["f1", "f2", "f3", "f1"])
      await verifier.authorize({ ...base, toolCallId: id });
    const rows = await audits(w.team, "approval.rejected");
    expect(rows.map((r) => r.target.toolCallId)).toEqual(["f1", "f2", "f3"]);
  });
});

describe("expiry and run ends", () => {
  it("TTL: past 1 h the call is denied and the run fails visibly (stopped, queue advanced, audited)", async () => {
    const w = await world();
    await askRule(w, "bash");
    const call = check(w, "bash", { command: "sleep 1" });
    const pending = await call.pending();
    expect(Date.parse(pending.expires_at) - Date.now()).toBeGreaterThan(APPROVAL_TTL_MS - 60_000);
    skewMs = APPROVAL_TTL_MS + 1_000;
    try {
      const result = await call.result();
      expect(result.decision === "deny" && result.message).toMatch(/expired after 1 hour/);
      expect(await runStatus(w.team, w.runId)).toBe("failed");
      const evs = await events(w.team, w.runId);
      const types = evs.map((e) => e.type);
      expect(types.indexOf("approval.resolved")).toBeLessThan(types.indexOf("run.failed"));
      expect(evs.find((e) => e.type === "run.failed")?.payload).toMatchObject({
        error: { code: "approval_expired" },
      });
      expect(evs.find((e) => e.type === "approval.resolved")?.payload).toMatchObject({
        decision: "expired",
        cause: "ttl",
      });
      // Pi is told to abort; the orchestrator's hook advanced the thread.
      await w.sb.until(() =>
        w.sb
          .frames("run.stop")
          .find((f) => f.run_id === w.runId && f.reason === "approval_expired"),
      );
      const thread = await fx.admin.query<{ status: string }>(
        `SELECT status FROM threads WHERE id = $1`,
        [w.threadId],
      );
      expect(thread.rows[0]?.status).toBe("idle");
      expect((await audits(w.team, "approval.expired"))[0]?.target).toMatchObject({ cause: "ttl" });
      // A late decision is refused.
      expect((await decide(w.owner, pending.approval_id, { decision: "allow" })).status).toBe(409);
    } finally {
      skewMs = 0;
    }
  });

  it("the sweep expires an approval nobody waits on", async () => {
    const w = await world();
    await askRule(w, "bash");
    const call = check(w, "bash", { command: "true" });
    const pending = await call.pending();
    skewMs = APPROVAL_TTL_MS + 60_000;
    try {
      await fx.replica(1).deps.approvals.sweep(0);
      expect((await approvalRow(pending.approval_id)).status).toBe("expired");
      expect((await call.result()).decision).toBe("deny");
    } finally {
      skewMs = 0;
    }
  });

  it("Stop while pending: the approval expires (run_cancelled) before the run's terminal event", async () => {
    const w = await world();
    await askRule(w, "bash");
    const call = check(w, "bash", { command: "true" });
    const pending = await call.pending();
    const stop = await w.owner.browser.post(`/v1/runs/${w.runId}/cancel`, {});
    expect(stop.status, JSON.stringify(stop.json)).toBe(200);
    expect((await call.result()).decision).toBe("deny");
    expect(await approvalRow(pending.approval_id)).toMatchObject({
      status: "expired",
      cause: "run_cancelled",
    });
    const types = (await events(w.team, w.runId)).map((e) => e.type);
    expect(types.indexOf("approval.resolved")).toBeLessThan(types.indexOf("run.interrupted"));
    expect((await decide(w.owner, pending.approval_id, { decision: "allow" })).status).toBe(409);
  });

  it("a budget stop expires pending approvals (D30) and lets the step finish", async () => {
    const w = await world();
    await askRule(w, "bash");
    const call = check(w, "bash", { command: "true" });
    const pending = await call.pending();
    await fx.replica(1).deps.runs.stopForBudget({ team_id: w.team, scope: "team" });
    const result = await call.result();
    expect(result.decision === "deny" && result.reasons[0]?.code).toBe("budget_exhausted");
    expect(await approvalRow(pending.approval_id)).toMatchObject({ cause: "budget_exhausted" });
    // No longer waiting: the step finishes (running), then the run ends budget_stopped as soon as
    // the sandbox answers the after-step stop (the fake answers at once).
    expect(["running", "budget_stopped"]).toContain(await runStatus(w.team, w.runId));
  });

  it("the sandbox connection closing while pending expires it; the run goes back to running", async () => {
    const w = await world();
    await askRule(w, "bash");
    const pending = await check(w, "bash", { command: "true" }).pending();
    w.sb.close();
    await expect.poll(async () => (await approvalRow(pending.approval_id)).status).toBe("expired");
    expect((await approvalRow(pending.approval_id)).cause).toBe("run_interrupted");
    expect(await runStatus(w.team, w.runId)).toBe("running");
  });
});

describe("Gate 2: a tampered kobe-policy cannot run an MCP write without a signed approval", () => {
  const TOOL = "mcp__jira__create_issue";
  const INPUT = { project: "OPS", summary: "R\u00e9sum\u00e9 keys", labels: ["sec"], priority: 2 };
  const verifier = () => fx.replica(1).deps.approvals.verifier;
  const engine = () =>
    createPolicyEngine({
      rules: createDbRuleSource(fx.db),
      settings: createDbSettingsSource(fx.db, 0),
      registry,
      connectors: CONNECTORS,
    });
  const proxyInput = (
    w: World,
    toolCallId: string,
    input: Record<string, unknown>,
  ): PolicyInput => ({
    actor: { user_id: w.owner.id, kind: "user" },
    team_id: w.team,
    agent: { agent_id: null, version: null, tools_allow: [], tools_deny: [] },
    run: { run_id: w.runId, thread_id: w.threadId, approval_mode: "ask-on-write" },
    tool: mcpTool(TOOL, "write"),
    tool_call_id: toolCallId,
    input: input as PolicyInput["input"],
    context: { enforcement_point: "mcp_proxy", connector_exposure: "all" },
  });

  /** A properly approved MCP call (through the sandbox and the API). */
  async function approved(w: World, toolCallId: string) {
    const call = check(w, TOOL, INPUT, toolCallId);
    const pending = await call.pending();
    expect((await decide(w.owner, pending.approval_id, { decision: "allow" })).status).toBe(200);
    expect((await call.result()).decision).toBe("allow");
    return pending.approval_id;
  }

  it("the policy re-check at the proxy requires approval for the write (no allow by itself)", async () => {
    const w = await world();
    const decision = await engine().decide(proxyInput(w, "tc-none", INPUT));
    expect(decision.effect).toBe("require_approval");
  });

  it("refuses a call that never asked (the extension skipped policy.check)", async () => {
    const w = await world();
    const out = await enforceMcpCall(engine(), verifier(), proxyInput(w, "skipped", INPUT));
    expect(out.decision).toBe("deny");
    expect(out.decision === "deny" && out.message).toMatch(/no_approval/);
    expect((await audits(w.team, "approval.rejected"))[0]?.target).toMatchObject({
      reason: "no_approval",
      enforcementPoint: "mcp_proxy",
    });
  });

  it("refuses a changed input, another user, a pending or denied approval", async () => {
    const w = await world();
    const id = await approved(w, "tc-a");
    const tampered = { ...INPUT, summary: "Delete everything" };
    expect(
      await verifier().authorize({
        teamId: w.team,
        userId: w.owner.id,
        runId: w.runId,
        toolCallId: "tc-a",
        tool: TOOL,
        input: tampered,
      }),
    ).toEqual({ ok: false, reason: "bad_mac" });
    // Unicode is not normalised: NFD of an approved NFC string is another input.
    expect(
      (
        await verifier().authorize({
          teamId: w.team,
          userId: w.owner.id,
          runId: w.runId,
          toolCallId: "tc-a",
          tool: TOOL,
          input: { ...INPUT, summary: INPUT.summary.normalize("NFD") },
        })
      ).ok,
    ).toBe(false);
    expect(
      await verifier().authorize({
        teamId: w.team,
        userId: randomUUID(),
        runId: w.runId,
        toolCallId: "tc-a",
        tool: TOOL,
        input: INPUT,
      }),
    ).toEqual({ ok: false, reason: "record_mismatch" });
    // The genuine call still works once (the refusals above consumed nothing).
    expect((await approvalRow(id)).consumed_at).toBeNull();
    const pendingCall = check(w, TOOL, INPUT, "tc-pending");
    await pendingCall.pending();
    expect(
      await verifier().authorize({
        teamId: w.team,
        userId: w.owner.id,
        runId: w.runId,
        toolCallId: "tc-pending",
        tool: TOOL,
        input: INPUT,
      }),
    ).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("canonical input: key order and number spelling don't matter; the exact approved call runs once", async () => {
    const w = await world();
    const id = await approved(w, "tc-c");
    const reordered = JSON.parse(
      '{"priority":2.0,"labels":["sec"],"summary":"R\\u00e9sum\\u00e9 keys","project":"OPS"}',
    ) as Record<string, unknown>;
    expect(canonicalJson(reordered)).toBe(canonicalJson(INPUT));
    const call = {
      teamId: w.team,
      userId: w.owner.id,
      runId: w.runId,
      toolCallId: "tc-c",
      tool: TOOL,
    };
    const out = await enforceMcpCall(engine(), verifier(), proxyInput(w, "tc-c", reordered));
    expect(out).toMatchObject({ decision: "allow", reasons: [{ code: "approval_granted" }] });
    expect((await approvalRow(id)).consumed_at).not.toBeNull();
    // Replay of the same approved call: consumed.
    expect(await verifier().authorize({ ...call, input: INPUT })).toEqual({
      ok: false,
      reason: "not_consumable",
    });
    expect((await audits(w.team, "approval.consumed")).map((a) => a.target.approvalId)).toEqual([
      id,
    ]);
  });

  it("refuses another tool call id, another run, another tool, an expired token and an ended run", async () => {
    const w = await world();
    await approved(w, "tc-d");
    const base = { teamId: w.team, userId: w.owner.id, runId: w.runId, tool: TOOL, input: INPUT };
    // The approval of tc-d is not an approval of tc-e (replayed under a new id).
    expect(await verifier().authorize({ ...base, toolCallId: "tc-e" })).toEqual({
      ok: false,
      reason: "no_approval",
    });
    // A different run of the same user.
    const other = await fx.run(w.team, w.owner);
    expect(await verifier().authorize({ ...base, runId: other, toolCallId: "tc-d" })).toEqual({
      ok: false,
      reason: "no_approval",
    });
    // The same ids, another (destructive) tool.
    expect(
      await verifier().authorize({ ...base, toolCallId: "tc-d", tool: "mcp__jira__delete_issue" }),
    ).toEqual({ ok: false, reason: "binding_mismatch" });
    // The token lives 10 minutes from the decision.
    skewMs = 11 * 60_000;
    try {
      expect(await verifier().authorize({ ...base, toolCallId: "tc-d" })).toEqual({
        ok: false,
        reason: "expired",
      });
    } finally {
      skewMs = 0;
    }
    // The run ended (Stop): its approvals can't be used any more.
    await approved(w, "tc-f");
    expect((await w.owner.browser.post(`/v1/runs/${w.runId}/cancel`, {})).status).toBe(200);
    expect(await verifier().authorize({ ...base, toolCallId: "tc-f" })).toEqual({
      ok: false,
      reason: "run_inactive",
    });
  });

  it("a token signed with another key does not verify (the sandbox never holds the key)", async () => {
    const w = await world();
    const id = await approved(w, "tc-k");
    // Rewrite the stored MAC as a sandbox would have to forge it: any other key.
    const forged = approvalKeyring("a-different-key-the-sandbox-made-up".padEnd(48, "x"));
    const { rows } = await fx.admin.query<{ token_expires_at: Date }>(
      `SELECT token_expires_at FROM approvals WHERE id = $1`,
      [id],
    );
    const { computeApprovalMac } = await import("@kobe/protocol/node");
    const mac = computeApprovalMac(
      forged.current.secret,
      {
        team_id: w.team,
        run_id: w.runId,
        tool_call_id: "tc-k",
        tool: TOOL,
        expires_at: must(rows[0], "row").token_expires_at.toISOString(),
      },
      { ...INPUT, summary: "forged" },
    );
    await fx.admin.query(`UPDATE approvals SET input_hmac = $1 WHERE id = $2`, [mac, id]);
    expect(
      await verifier().authorize({
        teamId: w.team,
        userId: w.owner.id,
        runId: w.runId,
        toolCallId: "tc-k",
        tool: TOOL,
        input: { ...INPUT, summary: "forged" },
      }),
    ).toEqual({ ok: false, reason: "bad_mac" });
  });
});
