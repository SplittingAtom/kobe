import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BRANCH_SUMMARIES_MAX,
  CAPABILITY_RUN_TOKEN,
  CAPABILITY_THREAD_BRANCH_SUMMARY,
  branchSummaryError,
  type BranchSummaryErrorCode,
} from "@kobe/protocol";
import { generateSessionKeyPair } from "@kobe/session-token";
import { recordModelUsage, type ModelUsageRecord } from "@kobe/db";
import { must } from "./testing/event-stream-fixture.js";
import { RunFixture, type RunWorld } from "./testing/run-fixture.js";
import type { TestResponse } from "./testing/browser.js";

/**
 * Make it current and carry a summary on the server (KOBE-548, CT11): `POST
 * /v1/threads/{id}/branch-summary` creates a hidden `branch_summary` run under the thread lock,
 * delivers `thread.branch_summary {from_leaf_entry_id, to_entry_id, focus}` with a run token,
 * mirrors Pi's `branch_summary` entry, makes it the leaf (with `thread.updated` on the run's
 * stream), ends the run and audits `thread.branch_summarized`; every refusal has its fixed message.
 */
const f = new RunFixture();
const CAPABLE = ["skill_bundles", CAPABILITY_RUN_TOKEN, CAPABILITY_THREAD_BRANCH_SUMMARY];

beforeAll(async () => {
  await f.setup({ runTokenKey: generateSessionKeyPair().signing });
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
     VALUES ('bs-fast', 'openai', 'gpt-fake', $1) ON CONFLICT (alias) DO NOTHING`,
    [w.owner.id],
  );
  await admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'bs-fast', true, $2)`,
    [w.team, w.owner.id],
  );
}

/** A team with a model, a capable sandbox, and a thread with two turns (the leaf is a2). */
async function world(capabilities: readonly string[] = CAPABLE) {
  const w = await f.world(1);
  await teamModel(w);
  const ws = await f.connect(w, 0, capabilities);
  const threadId = await f.thread(w.owner);
  const first = await f.message(w.owner, threadId, "first");
  const one = ws.reply(await ws.started(first), "answer one");
  await f.until(w.team, first, "completed");
  const second = await f.message(w.owner, threadId, "second");
  const two = ws.reply(await ws.started(second), "answer two");
  await f.until(w.team, second, "completed");
  return { w, ws, threadId, a1: one.assistant, a2: two.assistant };
}

const summarize = (w: RunWorld, threadId: string, body: object, replica = 0) =>
  f.on(replica, w.owner).post(`/v1/threads/${threadId}/branch-summary`, body);

async function summaryRuns(team: string, threadId: string) {
  const { rows } = await f.fx.admin.query<{ id: string; status: string; input: string }>(
    `SELECT id, status, input FROM runs
      WHERE team_id = $1 AND thread_id = $2 AND kind = 'branch_summary'`,
    [team, threadId],
  );
  return rows;
}

const audits = async (team: string) =>
  (
    await f.fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'thread.branch_summarized'
        ORDER BY seq`,
      [team],
    )
  ).rows.map((r) => r.target);

const leafOf = async (team: string, threadId: string) =>
  (
    await f.fx.admin.query<{ leaf: string | null }>(
      `SELECT leaf_entry_id AS leaf FROM threads WHERE team_id = $1 AND id = $2`,
      [team, threadId],
    )
  ).rows[0]?.leaf;

const expectError = (res: TestResponse, code: BranchSummaryErrorCode, status: number) => {
  expect(res.status, JSON.stringify(res.json)).toBe(status);
  // One fixed message per code: nothing of the sandbox's text.
  expect(res.json).toEqual(branchSummaryError(code));
};

describe("POST /v1/threads/{id}/branch-summary (KOBE-548)", () => {
  it("summarises: hidden run, ids and focus to the sandbox, entry mirrored as the leaf, event, audit", async () => {
    const { w, ws, threadId, a1, a2 } = await world();
    const pending = summarize(w, threadId, { to_entry_id: a1, focus: "keep the colours" }, 1);
    const frame = await ws.summarizing();
    expect(frame).toMatchObject({
      thread_id: threadId,
      from_leaf_entry_id: a2,
      to_entry_id: a1,
      focus: "keep the colours",
      model: { alias: "bs-fast", gateway_model: "openai/gpt-fake", api: "openai-completions" },
    });
    expect(frame.run_token.token.length).toBeGreaterThan(20);
    // Busy while summarising: the thread runs, a second one is refused (never queued).
    expect(await f.threadStatus(w.team, threadId)).toBe("running");
    expectError(await summarize(w, threadId, { to_entry_id: a1 }), "thread_busy", 409);
    const entryId = must(ws.branchSummarized(frame, { summary: "They explored C." }), "entry");
    const res = await pending;
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({ thread_id: threadId, entry_id: entryId, leaf_entry_id: entryId });
    // The entry is in the thread, under the target, and is the leaf.
    const entries = await f.on(0, w.owner).get(`/v1/threads/${threadId}/entries`);
    const mirrored = (
      entries.json.entries as { entry_id: string; parent_id: string | null; type: string }[]
    ).find((e) => e.entry_id === entryId);
    expect(mirrored).toMatchObject({ type: "branch_summary", parent_id: a1 });
    expect(await leafOf(w.team, threadId)).toBe(entryId);
    const [run] = await summaryRuns(w.team, threadId);
    expect(run).toMatchObject({ id: frame.run_id, status: "completed", input: "" });
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");
    // CT13: the run's stream carried the leaf move before its end.
    const events = await f.events(w.team, frame.run_id);
    const leafEvents = events.filter((e) => e.type === "thread.updated");
    expect(leafEvents.map((e) => e.payload)).toEqual([
      { thread_id: threadId, leaf_entry_id: entryId },
    ]);
    expect(events.at(-1)?.type).toBe("run.completed");
    // The token is revoked with the run; not a turn in the run list.
    const tokens = await f.fx.admin.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM run_tokens WHERE team_id = $1 AND run_id = $2`,
      [w.team, frame.run_id],
    );
    expect(tokens.rows[0]?.revoked_at).not.toBeNull();
    const runs = await f.on(0, w.owner).get(`/v1/threads/${threadId}/runs`);
    expect(JSON.stringify(runs.json)).not.toContain(frame.run_id);
    expect(await audits(w.team)).toEqual([
      { threadId, runId: frame.run_id, outcome: "completed", focused: true },
    ]);
    // The next send continues from the summary.
    const next = await f.message(w.owner, threadId, "third");
    expect((await ws.started(next)).parent_entry_id ?? entryId).toBe(entryId);
  });

  it("refuses thread_busy while a run is running or queued, and sends nothing", async () => {
    const { w, ws, threadId, a1 } = await world();
    const running = await f.message(w.owner, threadId, "third");
    await ws.started(running);
    const queued = await f.send(w.owner, threadId, "fourth");
    expect(queued.json.queued).toBe(true);
    expectError(await summarize(w, threadId, { to_entry_id: a1 }), "thread_busy", 409);
    expect(ws.branchSummaries()).toEqual([]);
    expect(await summaryRuns(w.team, threadId)).toEqual([]);
  });

  it("refuses a shared reader (read_only), and answers 404 to outsiders and for unknown entries", async () => {
    const { w, ws, threadId, a1 } = await world();
    const shared = await f.on(0, w.owner).post(`/v1/threads/${threadId}/share`, {
      visibility: "team",
    });
    expect(shared.status).toBe(200);
    const reader = must(w.others[0], "member");
    const byReader = await f.on(0, reader).post(`/v1/threads/${threadId}/branch-summary`, {
      to_entry_id: a1,
    });
    expectError(byReader, "read_only", 403);
    const stranger = await f.world();
    const outside = await f.on(0, stranger.owner).post(`/v1/threads/${threadId}/branch-summary`, {
      to_entry_id: a1,
    });
    expect([outside.status, outside.json.code]).toEqual([404, "thread_not_found"]);
    const unknown = await summarize(w, threadId, { to_entry_id: "nope0001" });
    expect([unknown.status, unknown.json.code]).toEqual([404, "entry_not_found"]);
    const bad = await summarize(w, threadId, { to_entry_id: a1, focus: "two\nlines" });
    expect(bad.status).toBe(400);
    expect(ws.branchSummaries()).toEqual([]);
    expect(await summaryRuns(w.team, threadId)).toEqual([]);
    expect(await audits(w.team)).toEqual([]);
  });

  it("refuses test threads (test_thread) and eval threads (skill_eval_thread)", async () => {
    const { w, ws, threadId, a1 } = await world();
    await f.fx.admin.query(`UPDATE threads SET is_test = true WHERE team_id = $1 AND id = $2`, [
      w.team,
      threadId,
    ]);
    expectError(await summarize(w, threadId, { to_entry_id: a1 }), "test_thread", 409);
    await f.fx.admin.query(
      `UPDATE threads SET is_test = false, skill_test = true WHERE team_id = $1 AND id = $2`,
      [w.team, threadId],
    );
    expectError(await summarize(w, threadId, { to_entry_id: a1 }), "test_thread", 409);
    const evalThread = randomUUID();
    await f.fx.admin.query(
      `INSERT INTO threads (team_id, id, owner_user_id, title, skill_eval)
       VALUES ($1, $2, $3, 'eval', true)`,
      [w.team, evalThread, w.owner.id],
    );
    const onEval = await summarize(w, evalThread, { to_entry_id: a1 });
    expect([onEval.status, onEval.json.code]).toEqual([409, "skill_eval_thread"]);
    expect(ws.branchSummaries()).toEqual([]);
  });

  it("refuses nothing_to_summarize for the leaf itself, before any run", async () => {
    const { w, ws, threadId, a2 } = await world();
    expectError(await summarize(w, threadId, { to_entry_id: a2 }), "nothing_to_summarize", 409);
    expect(ws.branchSummaries()).toEqual([]);
    expect(await summaryRuns(w.team, threadId)).toEqual([]);
  });

  it(`refuses the ${BRANCH_SUMMARIES_MAX + 1}st summary (summary_limit), counting the thread's entries`, async () => {
    const { w, ws, threadId, a1 } = await world();
    for (let i = 0; i < BRANCH_SUMMARIES_MAX; i++) {
      const id = `bs${String(i).padStart(6, "0")}`;
      await f.fx.admin.query(
        `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
         VALUES ($1, $2, $3, $4, 'branch_summary', $5)`,
        [w.team, threadId, id, a1, { type: "branch_summary", id, parentId: a1, summary: "s" }],
      );
    }
    expectError(await summarize(w, threadId, { to_entry_id: a1 }), "summary_limit", 409);
    expect(ws.branchSummaries()).toEqual([]);
    expect(await summaryRuns(w.team, threadId)).toEqual([]);
  });

  it.each([
    ["nothing_to_summarize", "nothing_to_summarize", 409],
    ["model_not_configured", "model_not_configured", 409],
    ["summary_failed", "summary_failed", 502],
    ["thread_busy", "thread_busy", 409],
    ["pi_unavailable", "sandbox_unavailable", 503],
  ] as const)(
    "maps the sandbox's %s to %s without relaying its text, audited, leaf unchanged",
    async (wire, code, status) => {
      const { w, ws, threadId, a1, a2 } = await world();
      const pending = summarize(w, threadId, { to_entry_id: a1 });
      const frame = await ws.summarizing();
      ws.branchSummarized(frame, { code: wire, message: "upstream said 402 at http://bifrost" });
      expectError(await pending, code, status);
      expect((await summaryRuns(w.team, threadId))[0]?.status).toBe("failed");
      expect(await f.threadStatus(w.team, threadId)).toBe("idle");
      expect(await leafOf(w.team, threadId)).toBe(a2);
      expect(await audits(w.team)).toEqual([
        { threadId, runId: frame.run_id, outcome: code, focused: false },
      ]);
    },
  );

  it("fails summary_failed when the reported entry is not a summary under the target", async () => {
    const { w, ws, threadId, a1, a2 } = await world();
    const pending = summarize(w, threadId, { to_entry_id: a1 });
    const frame = await ws.summarizing();
    // The sandbox names an existing message instead of the appended summary.
    ws.branchSummarized(frame, { summary: "S" }, { entry_id: a2, parent_id: a1 });
    expectError(await pending, "summary_failed", 502);
    expect((await summaryRuns(w.team, threadId))[0]?.status).toBe("failed");
    const events = await f.events(w.team, frame.run_id);
    expect(events.filter((e) => e.type === "thread.updated")).toEqual([]);
    // The mirror never moved the leaf (review M1).
    expect(await leafOf(w.team, threadId)).toBe(a2);
  });

  it("fails summary_failed when the summary sits elsewhere than the target or its parent (L4)", async () => {
    const { w, ws, threadId, a1, a2 } = await world();
    const pending = summarize(w, threadId, { to_entry_id: a1 });
    const frame = await ws.summarizing();
    // Pi (or a lying agent) put it under the old leaf instead.
    const misplaced = { ...frame, to_entry_id: a2 };
    const id = must(ws.branchSummarized(misplaced, { summary: "S" }), "entry");
    expectError(await pending, "summary_failed", 502);
    expect(await leafOf(w.team, threadId)).toBe(a2);
    expect(id).not.toBe(a2);
  });

  it("Stop racing a summary that landed: Pi's session wins, the member gets 200 (M2)", async () => {
    const { w, ws, threadId, a1 } = await world();
    const pending = summarize(w, threadId, { to_entry_id: a1 });
    const frame = await ws.summarizing();
    const stop = await f.on(0, w.owner).post(`/v1/runs/${frame.run_id}/cancel`, {});
    expect(stop.status, JSON.stringify(stop.json)).toBeLessThan(300);
    const entryId = must(ws.branchSummarized(frame, { summary: "S" }), "entry");
    const res = await pending;
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({ thread_id: threadId, entry_id: entryId, leaf_entry_id: entryId });
    expect(await leafOf(w.team, threadId)).toBe(entryId);
    expect((await summaryRuns(w.team, threadId))[0]?.status).toBe("cancelled");
    // The run was closed: no event on its stream; other tabs see it on the focus re-read.
    const events = await f.events(w.team, frame.run_id);
    expect(events.filter((e) => e.type === "thread.updated")).toEqual([]);
  });

  it("never sends thread.branch_summary to an agent without the capability", async () => {
    const { w, ws, threadId, a1 } = await world(["skill_bundles", CAPABILITY_RUN_TOKEN]);
    expectError(await summarize(w, threadId, { to_entry_id: a1 }), "summary_failed", 502);
    expect(ws.branchSummaries()).toEqual([]);
    expect((await summaryRuns(w.team, threadId))[0]?.status).toBe("failed");
  });

  it("refuses model_not_configured when the team has no model, creating no run", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0, CAPABLE);
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "first");
    const one = ws.reply(await ws.started(run), "answer");
    await f.until(w.team, run, "completed");
    const second = await f.message(w.owner, threadId, "second");
    ws.reply(await ws.started(second), "answer two");
    await f.until(w.team, second, "completed");
    expectError(
      await summarize(w, threadId, { to_entry_id: one.assistant }),
      "model_not_configured",
      409,
    );
    expect(await summaryRuns(w.team, threadId)).toEqual([]);
  });

  it("counts against the budget: a member whose budget is used up gets 429 before anything starts", async () => {
    const { w, ws, threadId, a1 } = await world();
    expect((await f.on(0, w.owner).put("/v1/team/budgets/team", { monthly_usd: 1 })).status).toBe(
      200,
    );
    await f.fx.admin.query(
      `UPDATE model_catalog SET input_usd_per_mtok = 1, output_usd_per_mtok = 1 WHERE alias = 'bs-fast'`,
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
    const res = await summarize(w, threadId, { to_entry_id: a1 });
    expect([res.status, res.json.code]).toEqual([429, "budget_exhausted"]);
    expect(ws.branchSummaries()).toEqual([]);
  });

  it("Stop aborts the branch summary; the member gets summary_failed and the leaf stays", async () => {
    const { w, ws, threadId, a1, a2 } = await world();
    const pending = summarize(w, threadId, { to_entry_id: a1 });
    const frame = await ws.summarizing();
    const stop = await f.on(0, w.owner).post(`/v1/runs/${frame.run_id}/cancel`, {});
    expect(stop.status, JSON.stringify(stop.json)).toBeLessThan(300);
    ws.branchSummarized(frame, { code: "summary_failed", message: "aborted" });
    expectError(await pending, "summary_failed", 502);
    expect((await summaryRuns(w.team, threadId))[0]?.status).toBe("cancelled");
    expect(await leafOf(w.team, threadId)).toBe(a2);
    expect(await audits(w.team)).toEqual([
      { threadId, runId: frame.run_id, outcome: "cancelled", focused: false },
    ]);
  });

  it("the run sweep ends a branch summary past its deadline, aborts it and audits timed_out", async () => {
    const { w, ws, threadId, a1 } = await world();
    const pending = summarize(w, threadId, { to_entry_id: a1 });
    const frame = await ws.summarizing();
    await f.fx.admin.query(
      `UPDATE runs SET started_at = now() - interval '1 hour' WHERE team_id = $1 AND id = $2`,
      [w.team, frame.run_id],
    );
    await f.fx.replica(1).deps.runs.sweep();
    expect((await summaryRuns(w.team, threadId))[0]?.status).toBe("failed");
    expect((await audits(w.team)).map((t) => t.outcome)).toEqual(["timed_out"]);
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");
    const stop = await ws.sb.until(() =>
      ws.sb.frames("run.stop").find((s) => s.run_id === frame.run_id),
    );
    expect(stop.mode).toBe("abort");
    ws.branchSummarized(frame, { code: "summary_failed", message: "cancelled" });
    expectError(await pending, "summary_failed", 502);
  });
});
