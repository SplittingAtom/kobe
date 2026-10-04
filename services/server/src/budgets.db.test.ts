import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { modelCatalog, modelProviders, recordModelUsage, type ModelUsageRecord } from "@kobe/db";
import { FAILURE_MESSAGES } from "./runs/failure-codes.js";
import type { MemoryMailer } from "./testing/mailer.js";
import { RunFixture } from "./testing/run-fixture.js";

/**
 * KOBE-42 against a real Postgres, the real sandbox wire and two replicas. Gate 2: "budget stops a
 * run after its current step" — the step's model call has finished (its usage is in the ledger),
 * the monitor sees the team budget used up, the run gets `run.stop after_step`, Pi finishes the
 * step and settles, and the run ends `budget_stopped` with a clear message; new runs are refused.
 */
const f = new RunFixture();
const PROVIDER = `bud-${randomUUID().slice(0, 6)}`;
const MODEL = `kobe-${PROVIDER}/m`;

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

async function priced(userId: string) {
  await f.fx.db
    .insert(modelProviders)
    .values({
      id: PROVIDER,
      kind: "openai_compatible",
      name: "Budget test",
      baseUrl: "http://budget.invalid",
      createdBy: userId,
    })
    .onConflictDoNothing();
  await f.fx.db
    .insert(modelCatalog)
    .values({
      alias: `${PROVIDER}-m`,
      providerId: PROVIDER,
      model: "m",
      inputUsdPerMtok: 1,
      outputUsdPerMtok: 1,
      createdBy: userId,
    })
    .onConflictDoNothing();
}

/** A finished model call of `dollars` (at $1 per 1M input tokens), as the shim records it. */
const call = (
  teamId: string,
  userId: string,
  dollars: number,
  runId?: string,
): ModelUsageRecord => ({
  teamId,
  userId,
  sandboxId: randomUUID(),
  runId,
  at: new Date(),
  route: "openai",
  model: MODEL,
  status: 200,
  inputTokens: dollars * 1_000_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  usageSource: "reported",
  durationMs: 100,
  ttfbMs: 10,
  aborted: false,
});

async function alerts(team: string) {
  const { rows } = await f.fx.admin.query<{ scope: string; threshold: number; emails: string }>(
    `SELECT a.scope, a.threshold, (SELECT count(*) FROM budget_alert_emails e WHERE e.alert_id = a.id) AS emails
       FROM budget_alerts a WHERE a.team_id = $1 ORDER BY a.threshold`,
    [team],
  );
  return rows.map((r) => [r.scope, r.threshold, Number(r.emails)]);
}

describe("team budgets API (D8: team admins)", () => {
  it("sets the team and member budgets, audited; members cannot, but see their own status", async () => {
    const w = await f.world(1);
    const bob = w.others[0];
    if (!bob) throw new Error("no member");
    await f.fx.activate(bob, w.team);
    const admin = f.on(0, w.owner);
    const set = await admin.put("/v1/team/budgets/team", {
      monthly_usd: 100,
      daily_usd: 10.555,
      user_requests_per_minute: 30,
    });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json.team).toMatchObject({
      monthly_usd: 100,
      daily_usd: 10.56,
      user_requests_per_minute: 30,
    });
    expect(set.json.effective_requests_per_minute).toBe(30);
    const member = await admin.put(`/v1/team/budgets/members/${bob.id}`, {
      monthly_usd: 5,
      daily_usd: null,
    });
    expect(member.json.members).toEqual([
      expect.objectContaining({ user_id: bob.id, monthly_usd: 5, daily_usd: null }),
    ]);
    expect(
      (
        await admin.put(`/v1/team/budgets/members/${randomUUID()}`, {
          monthly_usd: 1,
          daily_usd: null,
        })
      ).status,
    ).toBe(404);
    expect((await admin.put("/v1/team/budgets/team", { monthly_usd: -1 })).status).toBe(400);
    expect((await admin.put("/v1/team/budgets/team", { user_requests_per_minute: 0 })).status).toBe(
      400,
    );

    const asBob = f.on(0, bob);
    expect((await asBob.get("/v1/team/budgets")).status).toBe(403);
    expect((await asBob.put("/v1/team/budgets/team", { monthly_usd: 1e6 })).status).toBe(403);
    const status = await asBob.get("/v1/team/budgets/status");
    expect(status.status).toBe(200);
    expect(status.json.state).toBe("ok");
    // Bob sees the team's budget and his own, never another member's.
    expect(status.json.lines.map((l: { scope: string }) => l.scope).sort()).toEqual([
      "team",
      "team",
      "user",
    ]);
    expect((await admin.delete(`/v1/team/budgets/members/${bob.id}`)).status).toBe(200);
    const actions = await f.auditActions(w.team);
    expect(actions.filter((a) => a === "models.budget.changed")).toHaveLength(3);
  });
});

describe("Gate 2: a budget stops a run after its current step (D30)", () => {
  it("finishes the step in flight, ends the run budget_stopped, warns, emails and refuses new runs", async () => {
    const w = await f.world();
    await priced(w.owner.id);
    const admin = f.on(0, w.owner);
    expect((await admin.put("/v1/team/budgets/team", { monthly_usd: 1 })).status).toBe(200);
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "summarise the report");
    const queued = await f.message(w.owner, threadId, "and then this");
    const start = await ws.started(run);

    // The run's model call finishes ($2 at catalog prices) and the shim writes it to the ledger.
    await recordModelUsage(f.fx.db, [call(w.team, w.owner.id, 2, run)]);
    const monitor = f.fx.replica(1).deps.budgets;
    const evaluation = await monitor.evaluate(w.team);
    expect(evaluation).toEqual({ alerts: 2, stopped: ["team"] });

    // The queued message never runs; the active run is asked to stop after its step.
    expect(await f.status(w.team, queued)).toBe("budget_stopped");
    const stop = await ws.sb.until(() => ws.sb.frames("run.stop").find((s) => s.run_id === run));
    expect(stop).toMatchObject({ mode: "after_step", reason: "budget_exhausted" });
    expect(await f.status(w.team, run)).toBe("running");

    // Pi finishes the current step (its answer is kept) and settles.
    ws.reply(start, "Here is the summary.");
    await f.until(w.team, run, "budget_stopped");
    const events = await f.events(w.team, run);
    expect(events.map((e) => e.type)).toContain("text.delta");
    expect(events.at(-1)).toMatchObject({
      type: "run.budget_stopped",
      payload: { scope: "team", message: "The run stopped because the team's budget is used up." },
    });
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");

    // New runs are refused while the budget is used up.
    const next = await f.send(w.owner, threadId, "one more");
    expect(next.status).toBe(429);
    expect(next.json.code).toBe("budget_exhausted");

    // Warned at 80 % and stopped at 100 %, once per period; the team admin is emailed both.
    expect(await alerts(w.team)).toEqual([
      ["team", 80, 1],
      ["team", 100, 1],
    ]);
    expect((await monitor.evaluate(w.team)).alerts).toBe(0);
    await monitor.deliver();
    const mail = (f.fx.replica(1).deps.mailer as MemoryMailer).to(w.owner.email);
    expect(mail.map((m) => m.subject)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/monthly model budget is 80% used$/),
        expect.stringMatching(/monthly model budget is used up$/),
      ]),
    );
    const actions = await f.auditActions(w.team);
    expect(actions).toContain("models.budget.reached");
    expect(actions).toContain("run.budget_stopped");

    // Raising the budget lets runs start again.
    expect((await admin.put("/v1/team/budgets/team", { monthly_usd: 50 })).status).toBe(200);
    expect((await f.send(w.owner, threadId, "again")).status).toBe(201);
  });

  it("a step whose next model call the gateway refused still ends budget_stopped", async () => {
    const w = await f.world();
    await priced(w.owner.id);
    await f.on(0, w.owner).put("/v1/team/budgets/team", { daily_usd: 1 });
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "go");
    const start = await ws.started(run);
    await recordModelUsage(f.fx.db, [call(w.team, w.owner.id, 1, run)]);
    await f.fx.replica(0).deps.budgets.evaluate(w.team);
    await ws.sb.until(() => ws.sb.frames("run.stop").find((s) => s.run_id === run));
    // Before the stop reached Pi, its next model call got the shim's 402 (kobe-models' error).
    ws.event(start, { type: "agent_start" });
    ws.event(start, {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "kobe.model_error:model_budget_exhausted: gave up after 1 attempt",
      },
    });
    ws.event(start, { type: "turn_end", message: { role: "assistant" } });
    ws.event(start, { type: "agent_settled" });
    await f.until(w.team, run, "budget_stopped");
  });

  it("without a pending stop, the gateway's budget refusal fails the run with a clear message", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "go");
    const start = await ws.started(run);
    ws.event(start, { type: "agent_start" });
    ws.event(start, {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "kobe.model_error:model_budget_exhausted: gave up after 1 attempt",
      },
    });
    ws.event(start, { type: "turn_end", message: { role: "assistant" } });
    ws.event(start, { type: "agent_settled" });
    await f.until(w.team, run, "failed");
    expect((await f.events(w.team, run)).at(-1)).toMatchObject({
      payload: {
        error: {
          code: "model_budget_exhausted",
          message: FAILURE_MESSAGES.model_budget_exhausted,
        },
      },
    });
  });

  it("a member's own budget stops only that member's runs", async () => {
    const w = await f.world(1);
    const bob = w.others[0];
    if (!bob) throw new Error("no member");
    await priced(w.owner.id);
    await f.on(0, w.owner).put(`/v1/team/budgets/members/${bob.id}`, {
      monthly_usd: 0.5,
      daily_usd: null,
    });
    await recordModelUsage(f.fx.db, [call(w.team, bob.id, 1)]);
    expect(await f.fx.replica(0).deps.budgets.evaluate(w.team)).toMatchObject({
      stopped: [`user:${bob.id}`],
    });
    await f.fx.activate(bob, w.team);
    const bobThread = await f.thread(bob);
    expect((await f.send(bob, bobThread, "hi")).status).toBe(429);
    const ownerThread = await f.thread(w.owner);
    expect((await f.send(w.owner, ownerThread, "hi")).status).toBe(201);
    const status = await f.on(0, bob).get("/v1/team/budgets/status");
    expect(status.json.state).toBe("exhausted");
  });
});
