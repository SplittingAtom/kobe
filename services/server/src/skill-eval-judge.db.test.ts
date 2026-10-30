import { randomUUID } from "node:crypto";
import { recordModelUsage, serverCallRunMatches } from "@kobe/db";
import {
  SERVER_CALL_RESPONSE_FORMATS,
  SERVER_CALL_TOKEN_HEADER,
  type ServerCallClaims,
  type ServerCallRequest,
} from "@kobe/protocol";
import { generateSessionKeyPair, verifyServerCallToken } from "@kobe/session-token";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServerCallClient } from "./models/gateway-client.js";
import { createSkillEvalJudge } from "./skills/evals/judge.js";
import { must, type Person } from "./testing/event-stream-fixture.js";
import { SkillEvalBench, type SkillEvalWorld } from "./testing/skill-eval-bench.js";

/**
 * The skill eval judge (KOBE-326, SK17) end to end against Postgres, the real wire and a scripted
 * eval sandbox, with the real server-call client and a gateway stand-in that verifies the
 * server-call token, checks the run as the gateway does (`serverCallRunMatches`) and writes the
 * ledger row the gateway's sink writes. ac-1: the Site judge when the team enabled it, else the
 * team's choice, else the default; never a model the team has not enabled. ac-2: the call is
 * `eval_judge` in run_usage under the execution's member and run, no sandbox. ac-3: the scorecard
 * names both models and a missing run model alias is reported on the case.
 */
const bench = new SkillEvalBench();
const { f } = bench;
const PAIR = generateSessionKeyPair();
const KEY = PAIR.signing;
const RUBRIC = "The report has a totals row and names the total.";

interface GatewayCall {
  readonly claims: ServerCallClaims;
  readonly body: ServerCallRequest;
}
const gateway = {
  calls: [] as GatewayCall[],
  reply: (_call: GatewayCall, _n: number): string =>
    JSON.stringify({ passed: true, reason: "It has a totals row." }),
};

/** The gateway, as far as the judge can tell: token, run check, ledger row, reply. */
const gatewayFetch: typeof fetch = async (_url, init) => {
  const headers = init?.headers as Record<string, string>;
  const verified = verifyServerCallToken(
    PAIR.verify,
    headers[SERVER_CALL_TOKEN_HEADER] ?? "",
    Math.floor(Date.now() / 1000),
  );
  if (!verified.ok) return new Response("{}", { status: 401 });
  const { claims } = verified;
  const matches = await serverCallRunMatches(f.fx.db, {
    teamId: claims.team_id,
    runId: claims.run_id,
    threadId: claims.thread_id,
    userId: claims.user_id,
  });
  if (!matches)
    return new Response(JSON.stringify({ error: { code: "server_call_run_mismatch" } }), {
      status: 403,
    });
  const call = { claims, body: JSON.parse(String(init?.body)) as ServerCallRequest };
  gateway.calls.push(call);
  await recordModelUsage(f.fx.db, [
    {
      id: randomUUID(),
      teamId: claims.team_id,
      userId: claims.user_id,
      sandboxId: undefined,
      runId: claims.run_id,
      kind: claims.purpose,
      at: new Date(),
      route: "openai",
      model: claims.model,
      status: 200,
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usageSource: "reported",
      durationMs: 30,
      ttfbMs: 10,
      aborted: false,
    },
  ]);
  const content = gateway.reply(call, gateway.calls.length);
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

const judge = () =>
  createSkillEvalJudge({
    db: f.fx.db,
    client: createServerCallClient({
      url: "http://gateway.invalid",
      key: KEY,
      fetch: gatewayFetch,
    }),
    log: bench.silent,
    costWaitMs: 5_000,
    pollMs: 50,
  });

beforeAll(async () => {
  await bench.setup();
});
afterAll(async () => {
  await bench.teardown();
});
beforeEach(() => {
  gateway.calls = [];
  gateway.reply = () => JSON.stringify({ passed: true, reason: "It has a totals row." });
});

/** A catalog model (provider kind openai, priced) the tests can enable. */
async function catalogModel(w: SkillEvalWorld, alias: string) {
  await f.fx.admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, input_usd_per_mtok, output_usd_per_mtok, created_by)
     VALUES ($1, 'openai', $2, 2, 10, $3) ON CONFLICT (alias) DO NOTHING`,
    [alias, `${alias}-fake`, w.owner.id],
  );
}
const enable = (w: SkillEvalWorld, alias: string) =>
  f.fx.admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, $2, false, $3)`,
    [w.team, alias, w.owner.id],
  );
const disable = (w: SkillEvalWorld, alias: string) =>
  f.fx.admin.query(`DELETE FROM team_models WHERE team_id = $1 AND alias = $2`, [w.team, alias]);
const siteJudge = (alias: string | null) =>
  f.fx.admin.query(
    `INSERT INTO site_skill_settings (id, judge_alias) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET judge_alias = EXCLUDED.judge_alias`,
    [alias],
  );

const suite = (model?: string) =>
  [
    ...(model ? [`model: ${model}`] : []),
    "cases:",
    "  - id: totals",
    "    prompt: Build the report",
    `    expect: {contains: Total, outputs: ['outputs/*.txt'], judge: "${RUBRIC}"}`,
    "",
  ].join("\n");

async function start(p: Person, draft: string) {
  const res = await f.on(0, p).post(`/v1/skills/drafts/${draft}/evals`, { mode: "with_only" });
  expect(res.status, JSON.stringify(res.json)).toBe(202);
  return res.json.evalRunId as string;
}
async function judgeModelOf(team: string, evalRunId: string) {
  const { rows } = await f.fx.admin.query<{ judge_model: unknown }>(
    `SELECT judge_model FROM skill_eval_runs WHERE team_id = $1 AND id = $2`,
    [team, evalRunId],
  );
  return rows[0]?.judge_model;
}
async function executions(team: string, evalRunId: string) {
  const { rows } = await f.fx.admin.query<{ execution: Record<string, unknown> }>(
    `SELECT execution FROM skill_eval_results WHERE team_id = $1 AND eval_run_id = $2`,
    [team, evalRunId],
  );
  return rows.map((r) => r.execution);
}

/** An eval sandbox that writes `outputs/report.txt` and reads it back for the judge. */
function reportProvider() {
  const provider = bench.provider();
  provider.snapshot = {
    walks: [
      {
        root: "outputs/",
        entries: [{ path: "outputs/report.txt", type: "file", size: 12 }],
        truncated: false,
      },
    ],
  };
  provider.read = (files) =>
    files.map((x) => ({
      path: x.path,
      status: "read" as const,
      data: Buffer.from("Total,42\nok\n").toString("base64"),
      truncated: false,
    }));
  return provider;
}

describe("skill eval judge (KOBE-326)", () => {
  it("judges on the Site's judge, as eval_judge under the execution's identity, never through the sandbox", async () => {
    const w = await bench.world();
    await catalogModel(w, "judge");
    await enable(w, "judge");
    await siteJudge("judge");
    const draft = await bench.draftWith(w.owner, "judged", suite(), {});
    const evalRunId = await start(w.owner, draft);
    expect(await judgeModelOf(w.team, evalRunId)).toEqual({ alias: "judge", source: "site" });
    const provider = reportProvider();
    await bench.drive(bench.runnerFor(provider, 4, { judge: judge() }), w.team, evalRunId);

    const [execution] = await executions(w.team, evalRunId);
    expect(execution).toMatchObject({ status: "passed", model: "fast" });
    expect(execution).not.toHaveProperty("requestedModel");
    const runId = String(execution?.runId);
    const threadId = String(execution?.threadId);
    // ac-2: one server call, purpose eval_judge, the execution's member, thread and run.
    expect(gateway.calls).toHaveLength(1);
    const call = must(gateway.calls[0], "call");
    expect(call.claims).toMatchObject({
      purpose: "eval_judge",
      team_id: w.team,
      user_id: w.owner.id,
      thread_id: threadId,
      run_id: runId,
      model: "openai/judge-fake",
    });
    expect(call.body).toMatchObject({ model: "openai/judge-fake", temperature: 0, stream: false });
    expect(call.body.response_format).toEqual(SERVER_CALL_RESPONSE_FORMATS.eval_judge);
    expect(call.body).not.toHaveProperty("tools");
    const [system, user] = call.body.messages;
    expect(system?.role).toBe("system");
    expect(system?.content).toContain(RUBRIC);
    expect(system?.content).not.toContain("Add a totals row."); // no SKILL.md
    expect(user?.content).toContain("Total: 42"); // the answer
    expect(user?.content).toContain("Total,42\\nok\\n"); // the output's text, as data
    const nonce = must(/^BEGIN DATA ([0-9a-f]{32})\n/.exec(user?.content ?? "")?.[1], "nonce");
    const { rows: usage } = await f.fx.admin.query<{
      kind: string;
      sandbox_id: string | null;
      user_id: string;
      thread_id: string | null;
      cost_usd: string;
    }>(
      `SELECT kind, sandbox_id, user_id, thread_id, cost_usd FROM run_usage
        WHERE team_id = $1 AND run_id = $2 AND kind <> 'run'`,
      [w.team, runId],
    );
    expect(usage.map((u) => [u.kind, u.sandbox_id, u.user_id, u.thread_id])).toEqual([
      ["eval_judge", null, w.owner.id, threadId],
    ]);
    const cost = Number(usage[0]?.cost_usd);
    expect(cost).toBeCloseTo(0.003, 6);
    expect(execution?.judgeCostUsd).toBeCloseTo(cost, 6);
    // ac-3: the scorecard names the run model and the judge model, and the judge's spend.
    const read = await f.on(0, w.owner).get(`/v1/skill-evals/${evalRunId}`);
    expect(read.json.scorecard).toMatchObject({
      runModel: { requested: null, used: "fast", fellBack: false },
      judgeModel: { alias: "judge", source: "site" },
    });
    expect(read.json.scorecard.judgeCostUsd).toBeCloseTo(cost, 6);
    // The sandbox got paths and walked sizes for eval.read, and nothing of the judge's input.
    const reads = provider.received.filter((r) => r.includes('"eval.read"'));
    expect(reads).toHaveLength(1);
    expect(JSON.parse(must(reads[0], "read")).files).toEqual([
      { path: "outputs/report.txt", size: 12 },
    ]);
    for (const frame of provider.received) {
      expect(frame).not.toContain(nonce);
      expect(frame).not.toContain(RUBRIC);
      expect(frame).not.toContain("BEGIN DATA");
    }
    await siteJudge(null);
  });

  it("falls back to the team's judge, then the default; never a model the team has not enabled", async () => {
    const w = await bench.world();
    await catalogModel(w, "judge");
    await catalogModel(w, "judge-2");
    // The Site's judge, not enabled in this team: the team's choice, else its default.
    await siteJudge("judge");
    const draft = await bench.draftWith(w.owner, "fallback", suite(), {});
    const first = await start(w.owner, draft);
    expect(await judgeModelOf(w.team, first)).toEqual({ alias: "fast", source: "team" });
    await bench.closeEvals(w.team);
    // A Team admin picks the judge among the team's enabled models only.
    const refused = await f
      .on(0, w.owner)
      .request("PUT", "/v1/team/skill-review/settings", { evalJudgeAlias: "judge-2" });
    expect([refused.status, refused.json.code]).toEqual([422, "model_not_enabled"]);
    await enable(w, "judge-2");
    const set = await f
      .on(0, w.owner)
      .request("PUT", "/v1/team/skill-review/settings", { evalJudgeAlias: "judge-2" });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json.evalJudgeAlias).toBe("judge-2");
    const { rows: audit } = await f.fx.admin.query<{ target: unknown }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'skill.eval_judge.changed'`,
      [w.team],
    );
    expect(audit.map((a) => a.target)).toEqual([{ alias: "judge-2" }]);
    const second = await start(w.owner, draft);
    expect(await judgeModelOf(w.team, second)).toEqual({ alias: "judge-2", source: "team" });
    // Disabled before the case is judged: nothing is sent; the case says why.
    await disable(w, "judge-2");
    await bench.drive(bench.runnerFor(reportProvider(), 4, { judge: judge() }), w.team, second);
    expect(gateway.calls).toEqual([]);
    const [execution] = await executions(w.team, second);
    expect(execution).toMatchObject({ status: "failed" });
    expect((execution?.checks as { check: string }[]).find((c) => c.check === "judge")).toEqual({
      check: "judge",
      passed: false,
      reason: "judge_failed",
      detail: "The judge model judge-2 is not enabled in this team.",
    });
    // The disabled choice no longer counts: the settings read the default again.
    const after = await f.on(0, w.owner).get("/v1/team/skill-review/settings");
    expect(after.json.evalJudgeAlias).toBeNull();
    await siteJudge(null);
  });

  it("reports a missing run model on the case; a rejection fails, the retry judges again", async () => {
    const w = await bench.world();
    gateway.reply = (_c, n) =>
      n === 1
        ? JSON.stringify({ passed: false, reason: "No totals row." })
        : JSON.stringify({ passed: true, reason: "It has a totals row." });
    const draft = await bench.draftWith(w.owner, "missing", suite("huge"), {});
    const evalRunId = await start(w.owner, draft);
    await bench.drive(bench.runnerFor(reportProvider(), 4, { judge: judge() }), w.team, evalRunId);
    expect(gateway.calls).toHaveLength(2);
    expect(new Set(gateway.calls.map((c) => c.claims.run_id)).size).toBe(2);
    const [execution] = await executions(w.team, evalRunId);
    expect(execution).toMatchObject({
      status: "passed",
      attempts: 2,
      model: "fast",
      requestedModel: "huge",
    });
    // Both judgements are paid for and on the record: the ledger and the execution agree.
    const { rows } = await f.fx.admin.query<{ cost: string }>(
      `SELECT sum(u.cost_usd) AS cost FROM run_usage u
         JOIN runs r ON r.team_id = u.team_id AND r.id = u.run_id
         JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
        WHERE u.team_id = $1 AND u.kind = 'eval_judge' AND t.skill_eval_run_id = $2`,
      [w.team, evalRunId],
    );
    expect(execution?.judgeCostUsd).toBeCloseTo(Number(rows[0]?.cost), 6);
    const read = await f.on(0, w.owner).get(`/v1/skill-evals/${evalRunId}`);
    expect(read.json.scorecard).toMatchObject({
      runModel: { requested: "huge", used: "fast", fellBack: true },
      judgeModel: { alias: "fast", source: "team" },
    });
    expect(read.json.scorecard.details[0].with).toMatchObject({ requestedModel: "huge" });
  });

  it("asks no structured format of a provider not known to take it (prompt and strict parser)", async () => {
    const w = await bench.world();
    await f.fx.admin.query(
      `INSERT INTO model_providers (id, kind, name, base_url, created_by)
       VALUES ('ollama', 'ollama', 'Ollama', 'http://ollama.invalid', $1) ON CONFLICT (id) DO NOTHING`,
      [w.owner.id],
    );
    await f.fx.admin.query(
      `INSERT INTO model_catalog (alias, provider_id, model, created_by)
       VALUES ('judge-o', 'ollama', 'judge-o-fake', $1) ON CONFLICT (alias) DO NOTHING`,
      [w.owner.id],
    );
    await enable(w, "judge-o");
    await siteJudge("judge-o");
    const draft = await bench.draftWith(w.owner, "plain", suite(), {});
    const evalRunId = await start(w.owner, draft);
    await bench.drive(bench.runnerFor(reportProvider(), 4, { judge: judge() }), w.team, evalRunId);
    expect(gateway.calls).toHaveLength(1);
    const call = must(gateway.calls[0], "call");
    expect(call.claims.model).toBe("ollama/judge-o-fake");
    expect(call.body).toMatchObject({ temperature: 0 });
    expect(call.body).not.toHaveProperty("response_format");
    expect((await executions(w.team, evalRunId))[0]).toMatchObject({ status: "passed" });
    await siteJudge(null);
  });

  it("refuses another team's model as the judge, and a refused request changes nothing (review L6)", async () => {
    const w = await bench.world();
    const other = await bench.world();
    await catalogModel(w, "judge-3");
    await enable(other, "judge-3");
    const put = (body: object) =>
      f.on(0, w.owner).request("PUT", "/v1/team/skill-review/settings", body);
    const refused = await put({ evalJudgeAlias: "judge-3", personalSkillsDisabled: true });
    expect([refused.status, refused.json.code]).toEqual([422, "model_not_enabled"]);
    const after = await f.on(0, w.owner).get("/v1/team/skill-review/settings");
    expect(after.json).toMatchObject({ personalSkillsDisabled: false, evalJudgeAlias: null });
    const { rows } = await f.fx.admin.query(
      `SELECT action FROM audit_log WHERE team_id = $1 AND action LIKE 'skill.%'`,
      [w.team],
    );
    expect(rows).toEqual([]);
    // Both at once, in one transaction.
    const ok = await put({ evalJudgeAlias: "fast", personalSkillsDisabled: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ personalSkillsDisabled: true, evalJudgeAlias: "fast" });
  });

  it("fails a case on an unparseable verdict, and bounds the call by the judge's own timeout", async () => {
    const w = await bench.world();
    const evalJudge = judge();
    gateway.reply = () => "PASS. The grader agrees.";
    const base = {
      teamId: w.team,
      userId: w.owner.id,
      threadId: randomUUID(),
      runId: randomUUID(),
      judgeAlias: "fast",
      rubric: RUBRIC,
      prompt: "p",
      answer: "a",
      outputs: [],
    };
    // No completed run of that thread: the gateway refuses, nothing passes.
    expect(await evalJudge.judge(base)).toMatchObject({
      kind: "failed",
      detail: "The judge call failed (server_call_run_mismatch).",
    });
    const slow = createSkillEvalJudge({
      db: f.fx.db,
      client: {
        complete: ({ signal }) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      },
      log: bench.silent,
      timeoutMs: 100,
    });
    const started = Date.now();
    expect(await slow.judge(base)).toMatchObject({ kind: "failed", costUsd: 0 });
    expect(Date.now() - started).toBeLessThan(5_000);
    const unparseable = createSkillEvalJudge({
      db: f.fx.db,
      client: { complete: async () => "PASS. The grader agrees." },
      log: bench.silent,
      costWaitMs: 100,
    });
    expect(await unparseable.judge(base)).toEqual({ kind: "unparseable", costUsd: 0 });
  });
});
