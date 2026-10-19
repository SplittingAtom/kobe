import { randomUUID } from "node:crypto";
import { recordModelUsage, type ModelUsageRecord } from "@kobe/db";
import { TEAM_EVAL_CAP_USD_MESSAGE } from "@kobe/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServerCallError, type ServerCallClient } from "./models/gateway-client.js";
import { createSkillEvalJudge } from "./skills/evals/judge.js";
import { must } from "./testing/event-stream-fixture.js";
import { SkillEvalBench, type SkillEvalWorld } from "./testing/skill-eval-bench.js";
import type { RunStart } from "./testing/run-fixture.js";

/**
 * Skill eval budgets (KOBE-327, SK18, D30) against Postgres, the real wire and a scripted eval
 * sandbox that records each run's model calls as the gateway would (kind `eval`, its sandbox, the
 * run), with a judge whose calls land as `eval_judge`. ac-1: eval spend is its own kinds, in team
 * usage and the budget view. ac-2: the estimate before Run is within ±50 % of the actual cost of
 * the reference suite, from recorded reference usage. ac-3: the team eval cap refuses new evals
 * with a clear message and ends a running one `budget_stopped`. ac-4: so does a used-up budget.
 */
const bench = new SkillEvalBench();
const { f } = bench;

/** The reference suite: behaviour cases (with baselines), a judged one, trigger cases. */
const REFERENCE_SUITE = [
  "cases:",
  "  - id: totals",
  "    prompt: Add a totals row to the report",
  "    expect: {contains: Total}",
  "  - id: judged",
  "    prompt: Summarise the report for the board",
  '    expect: {contains: Total, judge: "Names the total and one risk."}',
  "  - id: chart",
  "    prompt: Describe the chart of the quarter",
  "    expect: {contains: Total}",
  "  - id: trigger",
  "    prompt: Format the quarterly report",
  "    expect: {triggers: true}",
  "  - id: unrelated",
  "    prompt: What is the capital of France?",
  "    expect: {triggers: false}",
  "",
].join("\n");

/**
 * Recorded reference usage (input, output tokens) per run of each case: two recordings of the
 * same suite on the same model (gate1, Ollama-sized prompts), the second with the natural run to
 * run spread (the history the estimate learns from, then the run it is checked against).
 */
const REFERENCE_USAGE: Record<"history" | "actual", Record<string, [number, number]>> = {
  history: {
    totals: [18_000, 900],
    judged: [22_000, 1_400],
    chart: [15_000, 700],
    trigger: [9_000, 300],
    unrelated: [6_000, 200],
  },
  actual: {
    totals: [21_000, 1_100],
    judged: [19_500, 1_250],
    chart: [17_500, 800],
    trigger: [8_000, 350],
    unrelated: [7_200, 150],
  },
};
const CASE_OF_PROMPT = new Map(
  [...REFERENCE_SUITE.matchAll(/id: (\S+)\n {4}prompt: (.+)/g)].map((m) => [m[2], m[1]]),
);

const usageRow = (
  w: SkillEvalWorld,
  over: Partial<ModelUsageRecord> & Pick<ModelUsageRecord, "kind">,
): ModelUsageRecord => ({
  id: randomUUID(),
  teamId: w.team,
  userId: w.owner.id,
  sandboxId: randomUUID(),
  runId: randomUUID(),
  at: new Date(),
  route: "openai",
  model: "openai/fast-fake",
  status: 200,
  inputTokens: 1_000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  usageSource: "reported",
  durationMs: 30,
  ttfbMs: 10,
  aborted: false,
  ...over,
});

/** An eval sandbox whose every run spends `tokens(caseId)` as kind `eval`. */
function spendingProvider(w: SkillEvalWorld, tokens: (caseId: string) => [number, number]) {
  const provider = bench.provider();
  provider.beforeReply = async (_ws, start: RunStart) => {
    const [input, output] = tokens(CASE_OF_PROMPT.get(start.message) ?? "");
    await recordModelUsage(f.fx.db, [
      usageRow(w, { kind: "eval", runId: start.run_id, inputTokens: input, outputTokens: output }),
    ]);
  };
  return provider;
}

/** The judge, with a gateway stand-in that records each call as `eval_judge` and passes. */
const judgeFor = (w: SkillEvalWorld) => {
  const client: ServerCallClient = {
    complete: async (input) => {
      await recordModelUsage(f.fx.db, [
        usageRow(w, {
          kind: input.purpose,
          sandboxId: undefined,
          runId: input.runId,
          inputTokens: 4_000,
          outputTokens: 60,
        }),
      ]);
      return JSON.stringify({ passed: true, reason: "Names the total and a risk." });
    },
  };
  return createSkillEvalJudge({ db: f.fx.db, client, log: bench.silent, costWaitMs: 2_000 });
};

/** A team whose `fast` model is priced ($2 / $10 per million tokens). */
async function pricedWorld() {
  const w = await bench.world();
  await f.fx.admin.query(
    `UPDATE model_catalog SET input_usd_per_mtok = 2, output_usd_per_mtok = 10 WHERE alias = 'fast'`,
  );
  return w;
}

async function startEval(w: SkillEvalWorld, draft: string, mode: "full" | "with_only") {
  const res = await f.on(0, w.owner).post(`/v1/skills/drafts/${draft}/evals`, { mode });
  return res;
}
const estimate = (w: SkillEvalWorld, draft: string, mode: "full" | "with_only") =>
  f.on(0, w.owner).get(`/v1/skills/drafts/${draft}/evals/estimate?mode=${mode}`);
/** The team eval cap: a budget route (the budget permission, never the review one). */
const putSettings = (w: SkillEvalWorld, body: object) =>
  f.on(0, w.owner).request("PUT", "/v1/team/budgets/eval-cap", body);
async function evalRow(w: SkillEvalWorld, id: string) {
  const { rows } = await f.fx.admin.query<{
    status: string;
    failure: { code: string; message: string } | null;
    progress_done: number;
  }>(`SELECT status, failure, progress_done FROM skill_eval_runs WHERE team_id = $1 AND id = $2`, [
    w.team,
    id,
  ]);
  return must(rows[0], "eval");
}

beforeAll(async () => {
  await bench.setup();
});
afterAll(async () => {
  await bench.teardown();
});

describe("skill eval budgets (KOBE-327)", () => {
  it("ac-1, ac-2: eval spend is its own kinds, and the estimate is within ±50 % on the reference suite", async () => {
    const w = await pricedWorld();
    const draft = await bench.draftWith(w.owner, "reference", REFERENCE_SUITE, {});
    // No history yet: the suite's own sizes at the catalog's prices.
    const none = await estimate(w, draft, "full");
    expect(none.status, JSON.stringify(none.json)).toBe(200);
    expect(none.json).toMatchObject({
      estimate: { executions: 8, basis: "suite_size" },
      blocked: null,
    });
    expect(none.json.estimate.costUsd).toBeGreaterThan(0);
    // A member's estimate never draws on anyone else's usage (review-327 R1): their own history
    // only, else the suite's sizes. Taken before and after the owner's evals: unchanged.
    const member = await f.member(w.team);
    const memberDraft = await bench.draftWith(member, "reference-copy", REFERENCE_SUITE, {});
    const memberEstimate = () =>
      f.on(0, member).get(`/v1/skills/drafts/${memberDraft}/evals/estimate?mode=full`);
    const memberBefore = await memberEstimate();
    expect(memberBefore.json.estimate).toMatchObject({ basis: "suite_size" });

    // The history: the reference suite once, with the first recording.
    const first = await startEval(w, draft, "full");
    expect(first.status, JSON.stringify(first.json)).toBe(202);
    const historyRun = first.json.evalRunId as string;
    await bench.drive(
      bench.runnerFor(
        spendingProvider(w, (c) => must(REFERENCE_USAGE.history[c], c)),
        4,
        { judge: judgeFor(w) },
      ),
      w.team,
      historyRun,
    );
    expect((await evalRow(w, historyRun)).status).toBe("completed");

    // ac-2: the estimate before Run, then the actual cost of the same suite. The owner is a
    // Team admin (who sees team usage): team-wide means.
    const before = await estimate(w, draft, "full");
    expect(before.json.estimate).toMatchObject({ executions: 8, basis: "team_history" });
    expect((await memberEstimate()).json.estimate).toEqual(memberBefore.json.estimate);
    const estimated = Number(before.json.estimate.costUsd);
    expect(estimated).toBeGreaterThan(0);
    expect(before.json.estimate.minutes).toBeGreaterThanOrEqual(1);
    const second = await startEval(w, draft, "full");
    expect(second.json.estimate).toEqual(before.json.estimate);
    const checkRun = second.json.evalRunId as string;
    await bench.drive(
      bench.runnerFor(
        spendingProvider(w, (c) => must(REFERENCE_USAGE.actual[c], c)),
        4,
        { judge: judgeFor(w) },
      ),
      w.team,
      checkRun,
    );
    const read = await f.on(0, w.owner).get(`/v1/skill-evals/${checkRun}`);
    expect(read.json.status).toBe("completed");
    const actual = read.json.scorecard.costUsd + read.json.scorecard.judgeCostUsd;
    expect(actual).toBeGreaterThan(0);
    expect(Math.abs(estimated - actual) / actual).toBeLessThanOrEqual(0.5);

    // ac-1: the ledger keeps eval and eval_judge apart from runs, and the card reconciles.
    const { rows: kinds } = await f.fx.admin.query<{ kind: string; usd: string }>(
      `SELECT u.kind, sum(u.cost_usd) AS usd FROM run_usage u
         JOIN runs r ON r.team_id = u.team_id AND r.id = u.run_id
         JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
        WHERE u.team_id = $1 AND t.skill_eval_run_id = $2 GROUP BY u.kind ORDER BY u.kind`,
      [w.team, checkRun],
    );
    expect(kinds.map((k) => k.kind)).toEqual(["eval", "eval_judge"]);
    expect(Number(kinds[0]?.usd)).toBeCloseTo(read.json.scorecard.costUsd, 5);
    expect(Number(kinds[1]?.usd)).toBeCloseTo(read.json.scorecard.judgeCostUsd, 5);
    const usage = await f.on(0, w.owner).get("/v1/team/usage");
    expect(usage.status, JSON.stringify(usage.json)).toBe(200);
    const byKind = new Set(usage.json.by_kind.map((k: { kind: string }) => k.kind));
    expect(byKind.has("eval") && byKind.has("eval_judge")).toBe(true);
    const budgets = await f.on(0, w.owner).get("/v1/team/budgets");
    expect(budgets.status, JSON.stringify(budgets.json)).toBe(200);
    const spent = Object.fromEntries(
      budgets.json.spent_by_kind.map((k: { kind: string; usd: number }) => [k.kind, k.usd]),
    );
    expect(Object.keys(spent).sort()).toEqual(["eval", "eval_judge"]);
    expect(budgets.json.eval_cap).toMatchObject({ usd: null, tokens: null });
    expect(budgets.json.eval_cap.month_usd).toBeCloseTo(spent.eval + spent.eval_judge, 5);
  });

  it("ac-3: a team eval cap refuses new evals with a clear message and ends a running one", async () => {
    const w = await pricedWorld();
    const set = await putSettings(w, { evalCap: { usd: 0.05 } });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json.eval_cap).toMatchObject({ usd: 0.05, tokens: null });
    const { rows: audit } = await f.fx.admin.query<{ target: unknown }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'skill.eval_cap.changed'`,
      [w.team],
    );
    expect(audit.map((a) => a.target)).toEqual([{ cap: { usd: 0.05 } }]);
    const cases = [
      "cases:",
      ...["a", "b", "c"].flatMap((id) => [
        `  - id: ${id}`,
        `    prompt: Case ${id}`,
        "    expect: {contains: Total}",
      ]),
      "",
    ].join("\n");
    const draft = await bench.draftWith(w.owner, "capped", cases, {});
    // Each run spends $0.03 (10 000 in, 1 000 out): the first passes the $0.05 cap, the second
    // reaches it, and nothing more starts.
    const provider = spendingProvider(w, () => [10_000, 1_000]);
    const started = await startEval(w, draft, "with_only");
    expect(started.status, JSON.stringify(started.json)).toBe(202);
    const evalRunId = started.json.evalRunId as string;
    await bench.drive(bench.runnerFor(provider, 1), w.team, evalRunId);
    const stopped = await evalRow(w, evalRunId);
    expect(stopped.status).toBe("budget_stopped");
    expect(stopped.failure?.code).toBe("eval_cap_reached");
    expect(stopped.progress_done).toBeLessThan(3);
    expect(provider.created.length).toBeLessThan(3);
    const read = await f.on(0, w.owner).get(`/v1/skill-evals/${evalRunId}`);
    expect(read.json).toMatchObject({ status: "budget_stopped", scorecard: null });
    // A new eval: refused before anything is stored, saying what and how to go on.
    const refused = await startEval(w, draft, "with_only");
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("eval_cap_reached");
    // The team's own spend is not in the message (aggregate amounts stay with the admins).
    expect(refused.json.message).toBe(
      "Your team's monthly eval cap ($0.05) is used up. A Team admin can raise or remove it.",
    );
    const est = await estimate(w, draft, "with_only");
    expect(est.json.blocked).toMatchObject({ code: "eval_cap_reached" });
    // Ordinary runs don't count against the cap, and raising it lets evals start again.
    const raised = await putSettings(w, { evalCap: { tokens: 1_000_000 } });
    expect(raised.json.eval_cap).toMatchObject({ usd: null, tokens: 1_000_000 });
    expect((await startEval(w, draft, "with_only")).status).toBe(202);
    await bench.closeEvals(w.team);
    for (const usd of [0, 0.001, 12.345]) {
      const bad = await putSettings(w, { evalCap: { usd } });
      expect([bad.status, bad.json.message]).toEqual([400, TEAM_EVAL_CAP_USD_MESSAGE]);
    }
  });

  it("the cap needs the budget permission: a member is refused, and the review settings take no cap", async () => {
    const w = await pricedWorld();
    const member = await f.member(w.team);
    const asMember = await f
      .on(0, member)
      .request("PUT", "/v1/team/budgets/eval-cap", { evalCap: { usd: 100 } });
    expect(asMember.status).toBe(403);
    // The skill review settings (team.skills.review) no longer set it at all.
    const viaReview = await f
      .on(0, w.owner)
      .request("PUT", "/v1/team/skill-review/settings", { evalCap: { usd: 100 } });
    expect(viaReview.status).toBe(400);
    const read = await f.on(0, w.owner).get("/v1/team/budgets");
    expect(read.json.eval_cap).toMatchObject({ usd: null, tokens: null });
  });

  it("shows an eval's costs only to its starter and Team admins (KOBE-328)", async () => {
    const w = await pricedWorld();
    const builder = await f.member(w.team);
    const viewer = await f.member(w.team);
    for (const p of [builder, viewer])
      await f.fx.admin.query(
        `UPDATE team_members SET role = 'builder' WHERE team_id = $1 AND user_id = $2`,
        [w.team, p.id],
      );
    const draft = await bench.draftWith(
      builder,
      "shared-costs",
      ["cases:", "  - id: a", "    prompt: Case a", "    expect: {contains: Total}", ""].join("\n"),
      {},
    );
    const meta = await f.on(0, builder).get(`/v1/skills/drafts/${draft}`);
    const shared = await f
      .on(0, builder)
      .request(
        "PATCH",
        `/v1/skills/drafts/${draft}`,
        { shared: true },
        { "if-match": `"${meta.json.draft.rev}"` },
      );
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);
    const started = await f
      .on(0, builder)
      .post(`/v1/skills/drafts/${draft}/evals`, { mode: "with_only" });
    const evalRunId = started.json.evalRunId as string;
    await bench.drive(
      bench.runnerFor(
        spendingProvider(w, () => [1_000, 100]),
        1,
      ),
      w.team,
      evalRunId,
    );
    const costsOf = async (p: typeof builder) => {
      const one = await f.on(0, p).get(`/v1/skill-evals/${evalRunId}`);
      const list = await f.on(0, p).get(`/v1/skill-evals?draft_id=${draft}`);
      expect(one.status, JSON.stringify(one.json)).toBe(200);
      return { one: one.json, listed: list.json.evals[0] };
    };
    for (const p of [builder, w.owner]) {
      const { one, listed } = await costsOf(p);
      expect(one.scorecard.costUsd).toBeGreaterThan(0);
      expect(listed.scorecard.costUsd).toBe(one.scorecard.costUsd);
      expect(one.costsHidden).toBeUndefined();
    }
    const { one, listed } = await costsOf(viewer);
    for (const run of [one, listed]) {
      expect(run).toMatchObject({ costsHidden: true, startedBy: builder.id, status: "completed" });
      expect(run.scorecard.passRate).toBe(1);
      expect(JSON.stringify(run)).not.toMatch(/costUsd|CostUsd/);
    }
  });

  it("M1: a gateway refusal at the cap with calls in flight ends the eval budget_stopped, never scored", async () => {
    const w = await pricedWorld();
    expect((await putSettings(w, { evalCap: { usd: 0.05 } })).status).toBe(200);
    // $0.045 spent and another eval call holding $0.01: the ledger alone is under the cap, but
    // the gateway (spend plus reservations) refuses the next call.
    await recordModelUsage(f.fx.db, [
      usageRow(w, { kind: "eval", inputTokens: 20_000, outputTokens: 500 }),
    ]);
    await f.fx.admin.query(
      `INSERT INTO budget_reservations (team_id, call_id, user_id, usd, tokens, eval, expires_at)
       VALUES ($1, $2, $3, 0.01, 100, true, now() + interval '10 minutes')`,
      [w.team, `held-${w.team}`, w.owner.id],
    );
    const cases = [
      "cases:",
      ...["a", "b"].flatMap((id) => [
        `  - id: ${id}`,
        `    prompt: Case ${id}`,
        "    expect: {contains: Total}",
      ]),
      "",
    ].join("\n");
    const draft = await bench.draftWith(w.owner, "refused", cases, {});
    const provider = bench.provider();
    provider.fail = () => "kobe.model_error:model_budget_exhausted: gave up after 1 attempt";
    const started = await startEval(w, draft, "with_only");
    expect(started.status, JSON.stringify(started.json)).toBe(202);
    const evalRunId = started.json.evalRunId as string;
    await bench.drive(bench.runnerFor(provider, 2), w.team, evalRunId);
    const stopped = await evalRow(w, evalRunId);
    expect(stopped.status).toBe("budget_stopped");
    expect(stopped.failure?.code).toBe("eval_cap_reached");
    // Not recorded, not retried, no scorecard: each execution ran at most once.
    expect(stopped.progress_done).toBe(0);
    expect(provider.created.length).toBeLessThanOrEqual(2);
    const { rows } = await f.fx.admin.query(
      `SELECT 1 FROM skill_eval_results WHERE team_id = $1 AND eval_run_id = $2 AND (execution IS NOT NULL OR attempt = 2)`,
      [w.team, evalRunId],
    );
    expect(rows).toEqual([]);
    const read = await f.on(0, w.owner).get(`/v1/skill-evals/${evalRunId}`);
    expect(read.json).toMatchObject({ status: "budget_stopped", scorecard: null });
  });

  it("R3: other gateway errors stay errors: retried, recorded, and the eval completes", async () => {
    const w = await pricedWorld();
    const draft = await bench.draftWith(
      w.owner,
      "flaky",
      ["cases:", "  - id: a", "    prompt: Case a", "    expect: {contains: Total}", ""].join("\n"),
      {},
    );
    const provider = bench.provider();
    provider.fail = () => "kobe.model_error:model_unavailable: gave up after 6 attempts";
    const started = await startEval(w, draft, "with_only");
    const evalRunId = started.json.evalRunId as string;
    await bench.drive(bench.runnerFor(provider, 1), w.team, evalRunId);
    expect((await evalRow(w, evalRunId)).status).toBe("completed");
    expect(provider.created).toHaveLength(2);
    const read = await f.on(0, w.owner).get(`/v1/skill-evals/${evalRunId}`);
    expect(read.json.scorecard.details[0].with).toMatchObject({ status: "error", attempts: 2 });
  });

  it("R3: a judge refused for a budget stops the eval; one that is merely unavailable fails the case", async () => {
    const judged = [
      "cases:",
      "  - id: a",
      "    prompt: Case a",
      '    expect: {contains: Total, judge: "Names the total."}',
      "",
    ].join("\n");
    const judgeThrowing = (code: string) =>
      createSkillEvalJudge({
        db: f.fx.db,
        client: {
          complete: async () => {
            throw new ServerCallError(code, code === "budget_exhausted" ? 402 : 503);
          },
        },
        log: bench.silent,
        costWaitMs: 100,
      });
    const stopped = await pricedWorld();
    const d1 = await bench.draftWith(stopped.owner, "judge-refused", judged, {});
    const e1 = (await startEval(stopped, d1, "with_only")).json.evalRunId as string;
    await bench.drive(
      bench.runnerFor(bench.provider(), 1, { judge: judgeThrowing("budget_exhausted") }),
      stopped.team,
      e1,
    );
    expect((await evalRow(stopped, e1)).status).toBe("budget_stopped");

    const flaky = await pricedWorld();
    const d2 = await bench.draftWith(flaky.owner, "judge-down", judged, {});
    const e2 = (await startEval(flaky, d2, "with_only")).json.evalRunId as string;
    await bench.drive(
      bench.runnerFor(bench.provider(), 1, { judge: judgeThrowing("budget_unavailable") }),
      flaky.team,
      e2,
    );
    expect((await evalRow(flaky, e2)).status).toBe("completed");
    const read = await f.on(0, flaky.owner).get(`/v1/skill-evals/${e2}`);
    const checks = read.json.scorecard.details[0].with.checks as {
      check: string;
      reason?: string;
    }[];
    expect(checks.find((c) => c.check === "judge")?.reason).toBe("judge_failed");
  });

  it("ac-4: a used-up budget refuses new evals and ends a running one budget_stopped", async () => {
    const w = await pricedWorld();
    // $0.05 a month for the team: as above, the second run reaches it.
    await f.fx.admin.query(
      `INSERT INTO team_budgets (team_id, monthly_usd, updated_by) VALUES ($1, 0.05, $2)`,
      [w.team, w.owner.id],
    );
    const cases = [
      "cases:",
      ...["a", "b", "c"].flatMap((id) => [
        `  - id: ${id}`,
        `    prompt: Case ${id}`,
        "    expect: {contains: Total}",
      ]),
      "",
    ].join("\n");
    const draft = await bench.draftWith(w.owner, "budgeted", cases, {});
    const started = await startEval(w, draft, "with_only");
    const evalRunId = started.json.evalRunId as string;
    await bench.drive(
      bench.runnerFor(
        spendingProvider(w, () => [10_000, 1_000]),
        1,
      ),
      w.team,
      evalRunId,
    );
    const stopped = await evalRow(w, evalRunId);
    expect(stopped.status).toBe("budget_stopped");
    expect(stopped.failure).toEqual({
      code: "budget_exhausted",
      message:
        "Your team's monthly model budget is used up, so evals can't run until it resets or an admin raises it.",
    });
    const refused = await startEval(w, draft, "with_only");
    expect([refused.status, refused.json.code]).toEqual([409, "budget_exhausted"]);
  });
});
