import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAPABILITY_RUN_TOKEN,
  CAPABILITY_THREAD_COMPACT,
  compactThreadError,
  type CompactThreadErrorCode,
} from "@kobe/protocol";
import { deriveRunTokenKey } from "@kobe/protocol/node";
import { recordModelUsage, type ModelUsageRecord } from "@kobe/db";
import { must } from "./testing/event-stream-fixture.js";
import { RunFixture, type RunWorld } from "./testing/run-fixture.js";
import type { TestResponse } from "./testing/browser.js";

/**
 * Compact now on the server (KOBE-213, CE15): `POST /v1/threads/{id}/compact` creates a hidden
 * compaction run under the thread lock, delivers `thread.compact` with a run token like a
 * `run.start` (waking the sandbox), mirrors Pi's `compaction` entry and ends the run; busy
 * threads, Stop, budgets, other teams and users, and sandbox errors (never relayed) are covered.
 */
const f = new RunFixture();
const CAPABLE = [
  "skill_bundles",
  "builtin_skills",
  CAPABILITY_RUN_TOKEN,
  CAPABILITY_THREAD_COMPACT,
];

beforeAll(async () => {
  await f.setup({ runTokenKey: deriveRunTokenKey(new TextEncoder().encode("c".repeat(40))) });
});
afterAll(async () => {
  await f.teardown();
});

async function teamModel(w: RunWorld): Promise<void> {
  const admin = f.fx.admin;
  await admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1)
     ON CONFLICT (id) DO NOTHING`,
    [w.owner.id],
  );
  await admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by)
     VALUES ('cmp-fast', 'openai', 'gpt-fake', $1) ON CONFLICT (alias) DO NOTHING`,
    [w.owner.id],
  );
  await admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'cmp-fast', true, $2)`,
    [w.team, w.owner.id],
  );
}

/** A team with a model, a capable sandbox, and a thread with one finished turn. */
async function world(capabilities: readonly string[] = CAPABLE) {
  const w = await f.world(1);
  await teamModel(w);
  const ws = await f.connect(w, 0, capabilities);
  const threadId = await f.thread(w.owner);
  const run = await f.message(w.owner, threadId, "first");
  ws.reply(await ws.started(run), "answer");
  await f.until(w.team, run, "completed");
  return { w, ws, threadId, run };
}

const compact = (w: RunWorld, threadId: string, body: object = {}, replica = 0) =>
  f.on(replica, w.owner).post(`/v1/threads/${threadId}/compact`, body);

async function compactionRuns(team: string, threadId: string) {
  const { rows } = await f.fx.admin.query<{ id: string; status: string; input: string }>(
    `SELECT id, status, input FROM runs WHERE team_id = $1 AND thread_id = $2 AND kind = 'compaction'`,
    [team, threadId],
  );
  return rows;
}

const expectError = (res: TestResponse, code: CompactThreadErrorCode, status: number) => {
  expect(res.status, JSON.stringify(res.json)).toBe(status);
  // One fixed message per code: nothing of the sandbox's text.
  expect(res.json).toEqual(compactThreadError(code));
};

describe("POST /v1/threads/{id}/compact (KOBE-213)", () => {
  it("compacts an idle thread: hidden run, focus and token to the sandbox, entry mirrored, audited", async () => {
    const { w, ws, threadId } = await world();
    const pending = compact(w, threadId, { focus: "keep the API decisions" }, 1);
    const frame = await ws.compacting();
    expect(frame).toMatchObject({
      thread_id: threadId,
      focus: "keep the API decisions",
      model: { alias: "cmp-fast", gateway_model: "openai/gpt-fake", api: "openai-completions" },
    });
    expect(frame.run_token.token.length).toBeGreaterThan(20);
    // Busy while compacting: the thread runs, a second compaction is refused.
    expect(await f.threadStatus(w.team, threadId)).toBe("running");
    expectError(await compact(w, threadId), "thread_busy", 409);
    const entryId = ws.compacted(frame, { summary: "The user asked; Kobe answered." });
    const res = await pending;
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({
      thread_id: threadId,
      summary: "The user asked; Kobe answered.",
      first_kept_entry_id: expect.any(String),
      tokens_before: 4242,
      estimated_tokens_after: 512,
    });
    // The compaction entry is in the thread before the answer (the B5 marker reads it).
    const entries = await f.on(0, w.owner).get(`/v1/threads/${threadId}/entries`);
    const mirrored = (entries.json.entries as { entry_id: string; type: string }[]).find(
      (e) => e.entry_id === entryId,
    );
    expect(mirrored?.type).toBe("compaction");
    const [run] = await compactionRuns(w.team, threadId);
    expect(run).toMatchObject({ id: frame.run_id, status: "completed", input: "" });
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");
    // The run's token is revoked with the run.
    const tokens = await f.fx.admin.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM run_tokens WHERE team_id = $1 AND run_id = $2`,
      [w.team, frame.run_id],
    );
    expect(tokens.rows.length).toBe(1);
    expect(tokens.rows[0]?.revoked_at).not.toBeNull();
    // Not a turn: no run list entry, no pending message, no Retry.
    const runs = await f.on(0, w.owner).get(`/v1/threads/${threadId}/runs`);
    expect(JSON.stringify(runs.json)).not.toContain(frame.run_id);
    const audit = await f.fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'thread.compacted'`,
      [w.team],
    );
    expect(audit.rows.map((r) => r.target)).toEqual([
      { threadId, runId: frame.run_id, outcome: "completed", focused: true },
    ]);
  });

  it("refuses thread_busy while a run is active and sends nothing", async () => {
    const { w, ws, threadId } = await world();
    const run = await f.message(w.owner, threadId, "second");
    await ws.started(run);
    expectError(await compact(w, threadId), "thread_busy", 409);
    expect(ws.compactions()).toEqual([]);
    expect(await compactionRuns(w.team, threadId)).toEqual([]);
  });

  it("queues a message sent during the compaction and starts it afterwards", async () => {
    const { w, ws, threadId } = await world();
    const pending = compact(w, threadId);
    const frame = await ws.compacting();
    const queued = await f.send(w.owner, threadId, "after compaction");
    expect(queued.status).toBe(201);
    expect(queued.json.queued).toBe(true);
    ws.compacted(frame, { summary: "S" });
    expect((await pending).status).toBe(200);
    await ws.started(queued.json.run_id as string);
  });

  it("wakes a hibernated sandbox: the command waits for it and is delivered on connect", async () => {
    const w = await f.world();
    await teamModel(w);
    const threadId = await f.thread(w.owner);
    const pending = compact(w, threadId);
    await expect.poll(() => compactionRuns(w.team, threadId)).toHaveLength(1);
    const ws = await f.connect(w, 1, CAPABLE);
    ws.compacted(await ws.compacting(), { summary: "S" });
    expect((await pending).status).toBe(200);
  });

  it("Stop aborts the compaction; the member gets compaction_failed", async () => {
    const { w, ws, threadId } = await world();
    const pending = compact(w, threadId);
    const frame = await ws.compacting();
    const stop = await f.on(1, w.owner).post(`/v1/runs/${frame.run_id}/cancel`, {});
    expect(stop.status, JSON.stringify(stop.json)).toBe(200);
    const abort = await ws.sb.until(() =>
      ws.sb.frames("run.stop").find((s) => s.run_id === frame.run_id),
    );
    expect(abort.mode).toBe("abort");
    ws.compacted(frame, { code: "compaction_failed", message: "Compaction cancelled" });
    expectError(await pending, "compaction_failed", 502);
    expect((await compactionRuns(w.team, threadId))[0]?.status).toBe("cancelled");
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");
  });

  it("a budget stop aborts a compaction (it has no step to finish)", async () => {
    const { w, ws, threadId } = await world();
    const pending = compact(w, threadId);
    const frame = await ws.compacting();
    const affected = await f.fx.replica(1).deps.runs.stopForBudget({
      team_id: w.team,
      user_id: w.owner.id,
      scope: "user",
    });
    expect(affected).toEqual([frame.run_id]);
    const stop = await ws.sb.until(() =>
      ws.sb.frames("run.stop").find((s) => s.run_id === frame.run_id),
    );
    expect(stop.mode).toBe("abort");
    ws.compacted(frame, { code: "compaction_failed", message: "Compaction cancelled" });
    expectError(await pending, "compaction_failed", 502);
    expect((await compactionRuns(w.team, threadId))[0]?.status).toBe("budget_stopped");
  });

  it("refuses a member whose budget is used up (429) before anything starts", async () => {
    const { w, ws, threadId } = await world();
    expect((await f.on(0, w.owner).put("/v1/team/budgets/team", { monthly_usd: 1 })).status).toBe(
      200,
    );
    await f.fx.admin.query(
      `UPDATE model_catalog SET input_usd_per_mtok = 1, output_usd_per_mtok = 1 WHERE alias = 'cmp-fast'`,
    );
    const record: ModelUsageRecord = {
      id: randomUUID(),
      teamId: w.team,
      userId: w.owner.id,
      sandboxId: randomUUID(),
      runId: undefined,
      at: new Date(),
      route: "openai",
      model: "openai/gpt-fake",
      status: 200,
      inputTokens: 2_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usageSource: "reported",
      durationMs: 1,
      ttfbMs: 1,
      aborted: false,
    };
    await recordModelUsage(f.fx.db, [record]);
    await f.fx.replica(0).deps.budgets.evaluate(w.team);
    const res = await compact(w, threadId);
    expect(res.status, JSON.stringify(res.json)).toBe(429);
    expect(res.json.code).toBe("budget_exhausted");
    expect(ws.compactions()).toEqual([]);
  });

  it("answers 404 for another team's thread and another member's private thread", async () => {
    const { w, ws, threadId } = await world();
    const stranger = await f.world();
    const other = must(w.others[0], "member");
    for (const res of [
      await f.on(0, stranger.owner).post(`/v1/threads/${threadId}/compact`, {}),
      await f.on(0, other).post(`/v1/threads/${threadId}/compact`, {}),
    ]) {
      expect(res.status, JSON.stringify(res.json)).toBe(404);
      expect(res.json.code).toBe("thread_not_found");
    }
    expect(ws.compactions()).toEqual([]);
  });

  it.each([
    ["nothing_to_compact", "nothing_to_compact", 409],
    ["model_not_configured", "model_not_configured", 409],
    ["compaction_failed", "compaction_failed", 502],
    ["pi_unavailable", "sandbox_unavailable", 503],
  ] as const)(
    "maps the sandbox's %s to %s without relaying its text",
    async (wire, code, status) => {
      const { w, ws, threadId } = await world();
      const pending = compact(w, threadId);
      const frame = await ws.compacting();
      ws.compacted(frame, { code: wire, message: "upstream said 402 at http://bifrost.internal" });
      expectError(await pending, code, status);
      expect((await compactionRuns(w.team, threadId))[0]?.status).toBe("failed");
      expect(await f.threadStatus(w.team, threadId)).toBe("idle");
    },
  );

  it("never sends thread.compact to an agent that can't take it", async () => {
    const { w, ws, threadId } = await world([
      "skill_bundles",
      "builtin_skills",
      CAPABILITY_RUN_TOKEN,
    ]);
    expectError(await compact(w, threadId), "compaction_failed", 502);
    expect(ws.compactions()).toEqual([]);
    expect((await compactionRuns(w.team, threadId))[0]?.status).toBe("failed");
  });

  it("refuses model_not_configured when the team has no model, creating no run", async () => {
    const w = await f.world();
    await f.connect(w, 0, CAPABLE);
    const threadId = await f.thread(w.owner);
    expectError(await compact(w, threadId), "model_not_configured", 409);
    expect(await compactionRuns(w.team, threadId)).toEqual([]);
  });

  it("a lost connection fails the compaction, never leaves the thread interrupted", async () => {
    const { w, ws, threadId } = await world();
    const pending = compact(w, threadId);
    await ws.compacting();
    ws.kill();
    expectError(await pending, "sandbox_unavailable", 503);
    await expect
      .poll(async () => (await compactionRuns(w.team, threadId))[0]?.status)
      .toBe("failed");
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");
    const interrupted = await f.on(0, w.owner).get(`/v1/threads/${threadId}/runs`);
    expect(interrupted.json.interrupted_run ?? null).toBeNull();
  });

  it("answers at once when the sandbox reconnects mid-compaction (its old reply is void)", async () => {
    const { w, ws, threadId } = await world();
    const t0 = Date.now();
    const pending = compact(w, threadId);
    await ws.compacting();
    ws.kill();
    // The agent drops a reply finished after a reconnect (command ids are per connection); the
    // new connection's hello settles the orphaned command, well before its 10 s deadline here.
    await f.connect(w, 1, CAPABLE);
    expectError(await pending, "sandbox_unavailable", 503);
    expect(Date.now() - t0).toBeLessThan(8_000);
    expect((await compactionRuns(w.team, threadId))[0]?.status).toBe("failed");
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");
  });

  it("leaves the compaction's summary call out of the gauge's latest call", async () => {
    const { w, ws, threadId, run } = await world();
    const pending = compact(w, threadId);
    const frame = await ws.compacting();
    const usage = (runId: string, inputTokens: number, at: Date): ModelUsageRecord => ({
      id: randomUUID(),
      teamId: w.team,
      userId: w.owner.id,
      sandboxId: randomUUID(),
      runId,
      at,
      route: "openai",
      model: "openai/gpt-fake",
      status: 200,
      inputTokens,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usageSource: "reported",
      durationMs: 1,
      ttfbMs: 1,
      aborted: false,
    });
    await recordModelUsage(f.fx.db, [
      usage(run, 1000, new Date(Date.now() - 60_000)),
      usage(frame.run_id, 9000, new Date()),
    ]);
    ws.compacted(frame, { summary: "S" });
    expect((await pending).status).toBe(200);
    const res = await f.on(0, w.owner).get(`/v1/threads/${threadId}/usage`);
    expect(res.json.latest_call).toMatchObject({ run_id: run, input_tokens: 1000 });
    // Its spend still counts in the thread's totals.
    expect(res.json.totals.input_tokens).toBe(10_000);
  });
});
