import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skippedActionsSchema, type PolicyDecision } from "@kobe/protocol";
import { createDb, withTeam, type KobeDatabase } from "@kobe/db";
import { approvalKeyring } from "./approvals/index.js";
import { createPolicyEngine } from "./policy/engine.js";
import { createToolRegistry } from "./policy/registry.js";
import { createDbRuleSource, createDbSettingsSource } from "./policy/rule-store.js";
import { lastMirroredEntryId, restoreParts } from "./sandbox-wire/entries.js";
import { createDbRunContextSource, decidePolicyCheck } from "./sandbox-wire/policy-check.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";

/**
 * Scheduled runs are unattended-safe end to end (KOBE-178, D29/D32): a call that would ask is
 * denied at once (never queued), recorded as a skipped action, reported on the run's terminal event
 * and in the thread; allow-listed and read-only calls still run; no approval row ever exists for a
 * scheduled run. The MCP proxy's half is in `mcp.db.test.ts`.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
const sandboxes: FakeSandbox[] = [];
const extraDbs: KobeDatabase[] = [];
const KEY = approvalKeyring("approval-key-for-tests-".padEnd(48, "k"));

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

/** A running SCHEDULED run on the owner's fake sandbox. */
async function world(trigger: "schedule" | "user" = "schedule"): Promise<World> {
  const owner = await fx.person(`s${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`sd-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  if (trigger === "schedule") {
    await fx.admin.query(`UPDATE runs SET trigger = 'schedule' WHERE id = $1`, [runId]);
  }
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
  };
}

async function rule(w: World, effect: "allow" | "ask" | "deny", toolGlob: string) {
  const res = await w.owner.browser.post("/v1/team/policy/rules", {
    effect,
    tool_glob: toolGlob,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
}

async function count(sqlText: string, params: unknown[]): Promise<number> {
  const { rows } = await fx.admin.query<{ n: number }>(sqlText, params);
  return Number(must(rows[0], "count").n);
}

const approvalsOf = (w: World) =>
  count(`SELECT count(*)::int AS n FROM approvals WHERE team_id = $1 AND run_id = $2`, [
    w.team,
    w.runId,
  ]);

async function skippedRows(w: World) {
  const { rows } = await fx.admin.query<{
    tool_call_id: string;
    tool: string;
    risk_class: string;
    reason: string;
  }>(
    `SELECT tool_call_id, tool, risk_class, reason FROM run_skipped_actions
      WHERE team_id = $1 AND run_id = $2 ORDER BY created_at, tool_call_id`,
    [w.team, w.runId],
  );
  return rows;
}

async function settle(w: World): Promise<void> {
  const t = new Date().toISOString();
  w.sb.session = [
    { type: "message", id: "u1", parentId: null, timestamp: t, message: { role: "user" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: t, message: { role: "assistant" } },
  ];
  w.sb.event(w.runId, w.threadId, 1, { type: "agent_start" });
  w.sb.event(w.runId, w.threadId, 2, { type: "turn_end", message: { role: "assistant" } });
  w.sb.event(w.runId, w.threadId, 3, { type: "agent_settled" });
  await w.sb.until(() => w.sb.acked(w.runId) >= 3);
  await expect.poll(async () => (await runStatus(w)).status, { timeout: 10_000 }).toBe("completed");
}

async function runStatus(w: World) {
  const { rows } = await fx.admin.query<{ status: string }>(
    `SELECT status FROM runs WHERE team_id = $1 AND id = $2`,
    [w.team, w.runId],
  );
  return must(rows[0], "run");
}

async function terminalPayload(w: World): Promise<Record<string, unknown>> {
  const { rows } = await fx.admin.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND type = 'run.completed'`,
    [w.team, w.runId],
  );
  return must(rows[0], "run.completed").payload;
}

describe("a write that would ask is skipped and reported (ac-1)", () => {
  it("denies at once, records it, completes the run, reports it on the event and in the thread", async () => {
    const w = await world();
    await rule(w, "ask", "bash");
    const asked = check(w, "bash", { command: "rm -rf build" });
    const result = await asked.result();
    expect(result.decision).toBe("deny");
    expect(result.reasons[0]).toMatchObject({ code: "scheduled_run_no_prompt" });
    // The sandbox never got `policy.pending`, and nothing is waiting.
    expect(w.sb.frames("policy.pending")).toHaveLength(0);
    expect(await approvalsOf(w)).toBe(0);
    expect((await runStatus(w)).status).toBe("running");
    expect(await skippedRows(w)).toEqual([
      {
        tool_call_id: asked.toolCallId,
        tool: "bash",
        risk_class: "destructive",
        reason: "scheduled_run_no_prompt",
      },
    ]);
    // A second, plain (unlisted) write is skipped too; a read still runs.
    expect((await check(w, "write", { path: "a.txt", content: "x" }).result()).decision).toBe(
      "deny",
    );
    expect((await check(w, "grep", { pattern: "x" }).result()).decision).toBe("allow");

    await settle(w);
    const payload = await terminalPayload(w);
    const skipped = skippedActionsSchema.parse(payload.skipped_actions);
    expect(skipped.map((s) => [s.tool, s.risk, s.reason_code])).toEqual([
      ["bash", "destructive", "scheduled_run_no_prompt"],
      ["write", "write", "scheduled_run_no_prompt"],
    ]);
    expect(JSON.stringify(payload)).not.toContain("rm -rf");
    expect(await approvalsOf(w)).toBe(0);

    const { rows } = await fx.admin.query<{ entry_id: string; parent_id: string; payload: any }>(
      `SELECT entry_id, parent_id, payload FROM thread_entries
        WHERE team_id = $1 AND thread_id = $2 AND type = 'custom_message'`,
      [w.team, w.threadId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.parent_id).toBe("a1");
    expect(rows[0]?.payload).toMatchObject({
      customType: "kobe.skipped_actions",
      display: true,
    });
    expect(String(rows[0]?.payload.content)).toMatch(
      /Skipped actions[\s\S]*2 tool calls[\s\S]*bash/,
    );
    expect(String(rows[0]?.payload.content)).not.toContain("rm -rf");
    // Pi's leaf is untouched (the next run branches from it), and the entry is not the sync cursor.
    const thread = await fx.admin.query<{ leaf_entry_id: string }>(
      `SELECT leaf_entry_id FROM threads WHERE team_id = $1 AND id = $2`,
      [w.team, w.threadId],
    );
    expect(thread.rows[0]?.leaf_entry_id).toBe("a1");
    const cursor = await withTeam(fx.replica(0).deps.database.db, w.team, (tx) =>
      lastMirroredEntryId(tx, w.team, w.threadId),
    );
    expect(cursor).toBe("a1");

    // A Pi session restore never sends the note: as the last entry it would become Pi's resume point.
    const restored: string[] = [];
    for await (const part of restoreParts(fx.replica(0).deps.database.db, w.team, w.threadId)) {
      restored.push(...part.entries.map((e) => e.id));
    }
    expect(restored).toEqual(["u1", "a1"]);

    // Pi does not know the note: it is neither a branch point nor a place to move the leaf to.
    const summaryId = must(rows[0], "summary").entry_id;
    const branch = await w.owner.browser.post(`/v1/threads/${w.threadId}/messages`, {
      content: "again",
      parent_entry_id: summaryId,
    });
    expect([branch.status, branch.json.code]).toEqual([422, "invalid_parent_entry"]);
    const leaf = await w.owner.browser.post(`/v1/threads/${w.threadId}/leaf`, {
      entry_id: summaryId,
    });
    expect([leaf.status, leaf.json.code]).toEqual([404, "entry_not_found"]);
  });

  it("a run without skips gets neither the field nor a thread entry", async () => {
    const w = await world();
    expect((await check(w, "grep", { pattern: "x" }).result()).decision).toBe("allow");
    await settle(w);
    expect(await terminalPayload(w)).not.toHaveProperty("skipped_actions");
    expect(
      await count(
        `SELECT count(*)::int AS n FROM thread_entries WHERE team_id = $1 AND type = 'custom_message'`,
        [w.team],
      ),
    ).toBe(0);
  });

  it("an interactive run still asks and records no skipped action (no bypass)", async () => {
    const w = await world("user");
    await rule(w, "ask", "bash");
    const asked = check(w, "bash", { command: "ls" });
    await w.sb.until(() => w.sb.frames("policy.pending").find((f) => f.request_id));
    expect(await approvalsOf(w)).toBe(1);
    expect(await skippedRows(w)).toEqual([]);
    expect(asked.toolCallId).toBeTruthy();
  });
});

describe("allow-listed and read-only tools run; stricter rules still apply (ac-2)", () => {
  it("a team allow rule lets a write run unprompted, an ask or deny rule on top still wins", async () => {
    const w = await world();
    await rule(w, "allow", "write");
    await rule(w, "allow", "edit");
    expect((await check(w, "write", { path: "a.txt", content: "x" }).result()).decision).toBe(
      "allow",
    );
    expect((await check(w, "grep", { pattern: "x" }).result()).decision).toBe("allow");
    // Stricter team rules apply on top of the allow-list.
    await rule(w, "ask", "edit");
    const edit = await check(w, "edit", {
      path: "a.txt",
      edits: [{ oldText: "x", newText: "y" }],
    }).result();
    expect(edit.decision).toBe("deny");
    await rule(w, "deny", "grep");
    expect((await check(w, "grep", { pattern: "x" }).result()).decision).toBe("deny");
    expect((await skippedRows(w)).map((r) => [r.tool, r.reason])).toEqual([
      ["edit", "scheduled_run_no_prompt"],
      ["grep", "team_deny_rule"],
    ]);
    expect(await approvalsOf(w)).toBe(0);
  });
});

describe("defence in depth at the approval-creation seam", () => {
  const ask: PolicyDecision = {
    effect: "require_approval",
    risk: "write",
    reasons: [{ code: "team_ask_rule", stage: "ask_rule", message: "asked" }],
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };

  it("the policy check never hands a scheduled run's call to the approval broker", async () => {
    const w = await world();
    let brokerCalls = 0;
    const db = fx.replica(0).deps.database.db;
    const frame = {
      v: 1 as const,
      type: "policy.check" as const,
      request_id: "x1",
      run_id: w.runId,
      thread_id: w.threadId,
      tool_call_id: "call-seam",
      tool: "bash",
      input: { command: "ls" },
    };
    const result = await decidePolicyCheck(
      {
        db,
        // A (hypothetically broken) engine that asks: the seam must still not prompt.
        engine: { decide: () => Promise.resolve(ask) },
        registry: createToolRegistry(),
        approvals: {
          request: () => {
            brokerCalls += 1;
            return Promise.resolve({ decision: "deny" as const, reasons: [], message: "x" });
          },
        },
        runContext: createDbRunContextSource(),
        runMaxEvents: 1000,
      },
      { teamId: w.team, userId: w.owner.id, sandboxId: randomUUID(), connectionId: "c1" } as never,
      frame,
      new AbortController().signal,
      () => undefined,
    );
    expect(result.decision).toBe("deny");
    expect(result.reasons[0]).toMatchObject({ code: "scheduled_run_no_prompt" });
    expect(brokerCalls).toBe(0);
    expect(await approvalsOf(w)).toBe(0);
    expect((await skippedRows(w)).map((r) => r.tool_call_id)).toEqual(["call-seam"]);
  });

  it("the broker itself refuses to create an approval for a scheduled run", async () => {
    const w = await world();
    const outcome = await fx.replica(0).deps.approvals.broker.request(
      {
        teamId: w.team,
        userId: w.owner.id,
        connectionId: "c1",
        runId: w.runId,
        threadId: w.threadId,
        toolCallId: "call-broker",
        tool: "bash",
        input: { command: "ls" },
        decision: ask,
        signal: new AbortController().signal,
      },
      () => undefined,
    );
    expect(outcome.decision).toBe("deny");
    expect(await approvalsOf(w)).toBe(0);
    expect((await runStatus(w)).status).toBe("running");
  });
});
