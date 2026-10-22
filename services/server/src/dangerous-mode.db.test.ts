import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type KobeDatabase } from "@kobe/db";
import { approvalKeyring } from "./approvals/index.js";
import { createPolicyEngine } from "./policy/engine.js";
import { createDbRuleSource, createDbSettingsSource } from "./policy/rule-store.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";

/**
 * Dangerous mode at run time (AC1, KOBE-476): the server's `policy.check` allows a call that would
 * ask when the run's published agent version is an admin's Dangerous agent, audits each one, and
 * still refuses denied tools; a stricter site floor, a scheduled run, a draft (test chat) or a
 * personal agent whose user is no longer an admin turn it off.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
const sandboxes: FakeSandbox[] = [];
const extraDbs: KobeDatabase[] = [];
const KEY = approvalKeyring("approval-key-for-tests-".padEnd(48, "d"));
const FLOOR_KEY = "policy.approval_floor";

beforeAll(async () => {
  await fx.setup([{}], () => {
    const database = createDb(fx.database.appUrl);
    extraDbs.push(database);
    return {
      approvalKeys: KEY,
      approvals: { pollMs: 100 },
      sandboxWire: {
        sweep: false,
        engine: createPolicyEngine({
          rules: createDbRuleSource(database.db),
          settings: createDbSettingsSource(database.db, 0),
        }),
        tuning: { batchWindowMs: 20, resultPollMs: 200 },
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

/** A running `ask-all` run of a team admin (the team's creator) on their fake sandbox. */
async function world(): Promise<World> {
  const owner = await fx.person(`d${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`dm-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  await fx.admin.query(`UPDATE runs SET approval_mode = 'ask-all' WHERE id = $1`, [runId]);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE id = $1`,
    [runId],
  );
  const threadId = must(rows[0], "run").thread_id;
  const sandboxId = randomUUID();
  const token = auth.issue({ sandboxId, teamId: team, userId: owner.id });
  const sb = await FakeSandbox.connect(must(listeners[0], "listener").url, token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId);
  await sb.ready();
  const started = await fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: team, userId: owner.id },
      { runId, threadId, message: "hello" },
    );
  expect(started).toEqual({ ok: true });
  return { team, owner, runId, threadId, sb };
}

/** Creates and publishes an agent as the world's owner, and pins the run's thread to it. */
async function pin(
  w: World,
  scope: "team" | "personal",
  frontmatter: Record<string, unknown>,
  options: { readonly draft?: boolean } = {},
): Promise<string> {
  const created = await w.owner.browser.post("/v1/agents", {
    scope,
    frontmatter: { name: `Agent ${randomBytes(2).toString("hex")}`, ...frontmatter },
    prompt: "Do it.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  const published = await w.owner.browser.request(
    "POST",
    `/v1/agents/${id}/publish`,
    {},
    { "if-match": "*" },
  );
  expect(published.status, JSON.stringify(published.json)).toBe(201);
  await fx.admin.query(
    `UPDATE threads SET agent_scope = $2, agent_id = $3, agent_version = 1 WHERE id = $1`,
    [w.threadId, scope, id],
  );
  await fx.admin.query(`UPDATE runs SET agent_version = $2 WHERE id = $1`, [
    w.runId,
    options.draft ? null : 1,
  ]);
  return id;
}

let nextRequest = 0;
function check(w: World, tool: string, input: Record<string, unknown>) {
  const requestId = `r${(nextRequest += 1)}`;
  w.sb.send({
    v: 1,
    type: "policy.check",
    request_id: requestId,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: `call-${requestId}`,
    tool,
    input,
  });
  return {
    toolCallId: `call-${requestId}`,
    result: () =>
      w.sb.until(() => w.sb.frames("policy.result").find((f) => f.request_id === requestId)),
    pending: () =>
      w.sb.until(() => w.sb.frames("policy.pending").find((f) => f.request_id === requestId)),
  };
}

async function appliedRows(w: World) {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE action = 'policy.dangerous_mode.applied'
       AND team_id = $1 AND target->>'runId' = $2 ORDER BY seq`,
    [w.team, w.runId],
  );
  return rows.map((r) => r.target);
}

const approvalsOf = async (w: World) => {
  const { rows } = await fx.admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM approvals WHERE team_id = $1 AND run_id = $2`,
    [w.team, w.runId],
  );
  return Number(must(rows[0], "count").n);
};

describe("a Dangerous agent's calls (AC1)", () => {
  it("allows a call that would ask, without an approval, and audits it", async () => {
    const w = await world();
    const agentId = await pin(w, "team", { approval_mode: "dangerous" });
    const call = check(w, "bash", { command: "ls" });
    const result = await call.result();
    expect(result.decision).toBe("allow");
    expect(result.reasons[0]).toMatchObject({ code: "dangerous_mode", stage: "approval_mode" });
    expect(w.sb.frames("policy.pending")).toHaveLength(0);
    expect(await approvalsOf(w)).toBe(0);
    // The chat's badge: the thread read says its pinned version is Dangerous.
    const thread = await w.owner.browser.get(`/v1/threads/${w.threadId}`);
    expect(thread.status, JSON.stringify(thread.json)).toBe(200);
    expect(thread.json.agent_dangerous).toBe(true);
    expect(await appliedRows(w)).toEqual([
      {
        runId: w.runId,
        toolCallId: call.toolCallId,
        tool: "bash",
        agentId,
        agentVersion: 1,
        enforcementPoint: "sandbox",
      },
    ]);
  });

  it("still refuses the agent's denied tools and still asks for an ask rule", async () => {
    const w = await world();
    await pin(w, "team", { approval_mode: "dangerous", tools: { deny: ["bash"] } });
    const plain = await world();
    const calm = await plain.owner.browser.get(`/v1/threads/${plain.threadId}`);
    expect(calm.json.agent_dangerous).toBe(false);
    const denied = await check(w, "bash", { command: "ls" }).result();
    expect(denied.decision).toBe("deny");
    expect(denied.reasons[0]?.code).toBe("agent_tool_deny");
    const rule = await w.owner.browser.post("/v1/team/policy/rules", {
      effect: "ask",
      tool_glob: "ls",
    });
    expect(rule.status, JSON.stringify(rule.json)).toBe(201);
    await check(w, "ls", {}).pending();
    expect(await appliedRows(w)).toEqual([]);
  });

  it("is off under a site floor stricter than auto", async () => {
    const w = await world();
    await pin(w, "team", { approval_mode: "dangerous" });
    await fx.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ($1, 'ask-on-write')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [FLOOR_KEY],
    );
    try {
      await check(w, "bash", { command: "ls" }).pending();
      expect(await appliedRows(w)).toEqual([]);
    } finally {
      await fx.admin.query(`DELETE FROM site_settings WHERE key = $1`, [FLOOR_KEY]);
    }
  });

  it("is off for a draft's test chat and for a scheduled run", async () => {
    const draft = await world();
    await pin(draft, "team", { approval_mode: "dangerous" }, { draft: true });
    await check(draft, "bash", { command: "ls" }).pending();

    const scheduled = await world();
    await pin(scheduled, "team", { approval_mode: "dangerous" });
    await fx.admin.query(`UPDATE runs SET trigger = 'schedule' WHERE id = $1`, [scheduled.runId]);
    const result = await check(scheduled, "bash", { command: "ls" }).result();
    expect(result.decision).toBe("deny");
    expect(result.reasons[0]?.code).toBe("scheduled_run_no_prompt");
  });

  it("is off for a personal agent once its user is no longer an admin here", async () => {
    const w = await world();
    await pin(w, "personal", { approval_mode: "dangerous" });
    expect((await check(w, "bash", { command: "ls" }).result()).decision).toBe("allow");
    await fx.admin.query(
      `UPDATE team_members SET role = 'builder' WHERE team_id = $1 AND user_id = $2`,
      [w.team, w.owner.id],
    );
    await check(w, "bash", { command: "pwd" }).pending();
    expect(await appliedRows(w)).toHaveLength(1);
  });
});
