import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reapSkillEvals } from "./skills/evals/reaper.js";
import { purgeSkillEvals } from "./retention/skill-evals.js";
import { skillEvalEventStream } from "./skills/evals/events.js";
import { evalStreamAccess } from "./skills/evals/views.js";
import { SkillEvalBench, type FakeEvalProvider } from "./testing/skill-eval-bench.js";
import { must, type Person } from "./testing/event-stream-fixture.js";

/**
 * The skill eval runner (KOBE-325) end to end against Postgres, the real wire and a scripted eval
 * sandbox agent: a full run creates and destroys one sandbox per case per mode, the baseline loads
 * no skill and the "with" run only the eval's bundle (ac-1); the cap holds and a failing case is
 * retried once (ac-2); results are stored, scored and streamed (ac-3); eval sandboxes hold only
 * session tokens, are always deleted, and eval threads stay out of the member's lists (ac-4).
 */
const bench = new SkillEvalBench();
const { f, objects, blobs, silent } = bench;
const world = () => bench.world();
const draftWith = (...a: Parameters<SkillEvalBench["draftWith"]>) => bench.draftWith(...a);
const runnerFor = (provider: FakeEvalProvider, cap = 4) => bench.runnerFor(provider, cap);
const drive = (...a: Parameters<SkillEvalBench["drive"]>) => bench.drive(...a);
const closeEvals = (team: string) => bench.closeEvals(team);
const newProvider = () => bench.provider();

beforeAll(async () => {
  await bench.setup();
});
afterAll(async () => {
  await bench.teardown();
});

describe("skill eval runner (KOBE-325)", () => {
  it("runs a full eval: one sandbox per case per mode, baseline without skills, scored and streamed", async () => {
    const w = await world();
    const provider = newProvider();
    provider.snapshot = {
      walks: [
        {
          root: "outputs/",
          entries: [{ path: "outputs/report.txt", type: "file", size: 9 }],
          truncated: false,
        },
      ],
    };
    const id = await draftWith(
      w.owner,
      "report",
      [
        "cases:",
        "  - id: totals",
        "    prompt: Build the report from in.csv",
        "    files: [fixtures/in.csv]",
        "    expect: {contains: Total, outputs: ['outputs/*.txt']}",
        "  - id: unrelated",
        "    prompt: What is the capital of France?",
        "    expect: {triggers: false}",
        "",
      ].join("\n"),
      { "in.csv": "a,b\n1,2\n" },
    );
    const started = await f.on(0, w.owner).post(`/v1/skills/drafts/${id}/evals`, { mode: "full" });
    expect(started.status, JSON.stringify(started.json)).toBe(202);
    const evalRunId = started.json.evalRunId as string;
    expect(started.json.estimate).toMatchObject({ executions: 3 });
    const runner = runnerFor(provider);
    await drive(runner, w.team, evalRunId);

    const read = await f.on(0, w.owner).get(`/v1/skill-evals/${evalRunId}`);
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ status: "completed", progress: { done: 3, total: 3 } });
    expect(read.json.scorecard).toMatchObject({ passRate: 1, baselinePassRate: 1 });
    // One sandbox per execution, each deleted.
    expect(provider.created).toHaveLength(3);
    expect([...provider.deleted].sort()).toEqual([...provider.created].sort());
    expect(provider.live).toBe(0);
    // The baseline's run lists no skill; the "with" runs only the eval's bundle.
    const { rows: runs } = await f.fx.admin.query<{ with_skill: boolean; skill_refs: unknown[] }>(
      `SELECT x.with_skill, r.skill_refs FROM skill_eval_results x
         JOIN runs r ON r.team_id = x.team_id AND r.id = (x.execution ->> 'runId')::uuid
        WHERE x.team_id = $1 AND x.eval_run_id = $2`,
      [w.team, evalRunId],
    );
    const { rows: evalRow } = await f.fx.admin.query<{ runtime_hash: string }>(
      `SELECT runtime_hash FROM skill_eval_runs WHERE id = $1`,
      [evalRunId],
    );
    const hash = evalRow[0]?.runtime_hash;
    for (const r of runs) {
      const hashes = (r.skill_refs as { sha256?: string }[]).map((s) => s.sha256);
      expect(hashes).toEqual(r.with_skill ? [hash] : []);
    }
    // Eval threads are not the member's chats, and nobody posts into them.
    const list = await f.on(0, w.owner).get("/v1/threads");
    const { rows: threads } = await f.fx.admin.query<{ id: string }>(
      `SELECT id FROM threads WHERE team_id = $1 AND skill_eval`,
      [w.team],
    );
    expect(threads).toHaveLength(3);
    const listed = JSON.stringify(list.json);
    for (const t of threads) expect(listed).not.toContain(t.id);
    const post = await f
      .on(0, w.owner)
      .post(`/v1/threads/${must(threads[0], "thread").id}/messages`, { content: "hi" });
    expect(post.status).toBe(409);
    expect(post.json).toMatchObject({ code: "skill_eval_thread" });
    // The stream replays the progress and ends with the completion.
    const events = await f.on(0, w.owner).get(`/v1/skill-evals/${evalRunId}/events`);
    expect(events.status).toBe(200);
    expect(events.text.match(/event: skill\.eval\.progress/g)).toHaveLength(3);
    expect(events.text).toContain("event: skill.eval.completed");
    expect(events.text).not.toContain("Total: 42");
    expect(events.text).toContain("id: done");
    // A reconnect after the end gets no stream again (EventSource stops on 204).
    const again = await f
      .on(0, w.owner)
      .get(`/v1/skill-evals/${evalRunId}/events`, { "last-event-id": "done" });
    expect(again.status).toBe(204);
  });

  it("retries a failing case once in a new thread and sandbox, within a cap of one", async () => {
    const w = await world();
    await f.fx.admin.query(
      `INSERT INTO site_skill_settings (id, eval_limits) VALUES (1, '{"maxConcurrentSandboxes": 1}')
       ON CONFLICT (id) DO UPDATE SET eval_limits = EXCLUDED.eval_limits`,
    );
    const provider = newProvider();
    provider.answer = (_start, attempt) => (attempt === 1 ? "no idea" : "Total: 7");
    const id = await draftWith(
      w.owner,
      "retry",
      ["cases:", "  - id: a", "    prompt: Sum it", "    expect: {contains: Total}", ""].join("\n"),
      {},
    );
    const started = await f.on(0, w.owner).post(`/v1/skills/drafts/${id}/evals`, {
      mode: "with_only",
    });
    expect(started.status, JSON.stringify(started.json)).toBe(202);
    const evalRunId = started.json.evalRunId as string;
    const runner = runnerFor(provider);
    await drive(runner, w.team, evalRunId);
    await f.fx.admin.query(`UPDATE site_skill_settings SET eval_limits = '{}' WHERE id = 1`);
    const { rows } = await f.fx.admin.query<{ execution: Record<string, unknown> }>(
      `SELECT execution FROM skill_eval_results WHERE team_id = $1 AND eval_run_id = $2`,
      [w.team, evalRunId],
    );
    expect(rows[0]?.execution).toMatchObject({ status: "passed", attempts: 2 });
    expect(provider.created).toHaveLength(2);
    expect(new Set(provider.created).size).toBe(2);
    expect(provider.maxLive).toBe(1);
    expect(provider.deleted).toHaveLength(2);
  });

  it("cancels: nothing more starts, the sandbox goes, and the reaper finds nothing left", async () => {
    const w = await world();
    const provider = newProvider();
    const id = await draftWith(
      w.owner,
      "cancel",
      ["cases:", "  - id: a", "    prompt: Slow", "    expect: {contains: Total}", ""].join("\n"),
      {},
    );
    const started = await f.on(0, w.owner).post(`/v1/skills/drafts/${id}/evals`, {
      mode: "with_only",
    });
    const evalRunId = started.json.evalRunId as string;
    const cancelled = await f.on(0, w.owner).post(`/v1/skill-evals/${evalRunId}/cancel`, {});
    expect(cancelled.status).toBe(202);
    expect(cancelled.json).toMatchObject({ status: "cancelled", scorecard: null });
    const runner = runnerFor(provider);
    expect(await runner.sweep()).toBe(0);
    expect(provider.created).toHaveLength(0);
    const reaped = await reapSkillEvals({
      db: f.fx.db,
      provider,
      runs: f.fx.replica(0).deps.runs,
      log: silent,
    });
    expect(reaped).toEqual({ executions: 0, claims: 0, departed: 0 });
  });

  it("on shutdown puts a running execution back without using its attempt (review M2)", async () => {
    const w = await world();
    const provider = newProvider();
    provider.beforeReply = () => new Promise(() => {}); // the run never answers
    const id = await draftWith(
      w.owner,
      "shutdown",
      ["cases:", "  - id: a", "    prompt: Wait", "    expect: {contains: Total}", ""].join("\n"),
      {},
    );
    const started = await f.on(0, w.owner).post(`/v1/skills/drafts/${id}/evals`, {
      mode: "with_only",
    });
    const evalRunId = started.json.evalRunId as string;
    const runner = runnerFor(provider);
    await runner.sweep();
    const state = async () =>
      (
        await f.fx.admin.query<{ state: string; attempt: number; thread_id: string | null }>(
          `SELECT state, attempt, thread_id FROM skill_eval_results WHERE team_id = $1 AND eval_run_id = $2`,
          [w.team, evalRunId],
        )
      ).rows[0];
    await expect.poll(async () => (await state())?.state, { timeout: 20_000 }).toBe("running");
    await runner.shutdown(10_000);
    expect(await state()).toEqual({ state: "queued", attempt: 1, thread_id: null });
    expect(provider.deleted).toEqual(provider.created);
    const { rows } = await f.fx.admin.query<{ status: string }>(
      `SELECT status FROM runs WHERE team_id = $1 AND thread_id = $2`,
      [w.team, must(provider.created[0], "thread")],
    );
    expect(rows[0]?.status).toBe("cancelled");
    await closeEvals(w.team);
  });

  it("the reaper takes over only executions whose heartbeat stopped (review M2)", async () => {
    const w = await world();
    const provider = newProvider();
    const id = await draftWith(
      w.owner,
      "reap",
      [
        "cases:",
        "  - id: a",
        "    prompt: P",
        "    expect: {contains: Total}",
        "  - id: b",
        "    prompt: Q",
        "    expect: {contains: Total}",
        "",
      ].join("\n"),
      {},
    );
    const started = await f.on(0, w.owner).post(`/v1/skills/drafts/${id}/evals`, {
      mode: "with_only",
    });
    const evalRunId = started.json.evalRunId as string;
    // Two executions "running" on a replica that is gone: one beat recently (past its deadline,
    // still collecting), one has been silent for minutes.
    const live = randomUUID();
    const dead = randomUUID();
    for (const [thread, caseId, beat] of [
      [live, "a", "now()"],
      [dead, "b", "now() - interval '5 minutes'"],
    ] as const) {
      await f.fx.admin.query(
        `INSERT INTO threads (team_id, id, owner_user_id, title, skill_eval, skill_eval_run_id)
         VALUES ($1, $2, $3, 'e', true, $4)`,
        [w.team, thread, w.owner.id, evalRunId],
      );
      await f.fx.admin.query(
        `UPDATE skill_eval_results SET state = 'collecting', thread_id = $3,
                deadline_at = now() - interval '3 minutes', updated_at = ${beat}
          WHERE team_id = $1 AND eval_run_id = $2 AND case_id = '${caseId}'`,
        [w.team, evalRunId, thread],
      );
    }
    const reaped = await reapSkillEvals({
      db: f.fx.db,
      provider,
      runs: f.fx.replica(0).deps.runs,
      log: silent,
    });
    expect(reaped.executions).toBe(1);
    const { rows } = await f.fx.admin.query<{ case_id: string; state: string; attempt: number }>(
      `SELECT case_id, state, attempt FROM skill_eval_results
        WHERE team_id = $1 AND eval_run_id = $2 ORDER BY case_id`,
      [w.team, evalRunId],
    );
    expect(rows).toEqual([
      { case_id: "a", state: "collecting", attempt: 1 },
      { case_id: "b", state: "queued", attempt: 1 },
    ]);
    expect(provider.deleted).toEqual([dead]);
    await closeEvals(w.team);
  });

  it("retention purges past held starters' runs instead of stalling behind them (review M3)", async () => {
    const w = await world();
    const held = await f.member(w.team);
    const [placer, approver] = [await f.fx.person("placer325"), await f.fx.person("appr325")];
    for (const p of [placer, approver])
      await f.fx.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [p.id]);
    const insertRuns = (userId: string, n: number, age: string) =>
      f.fx.admin.query(
        `INSERT INTO skill_eval_runs (team_id, started_by, subject_kind, subject_id, subject_rev,
           skill_name, package_hash, runtime_hash, bundle_key, bundle_size, mode, status, suite,
           limits, progress_total, started_at, finished_at)
         SELECT $1, $2, 'draft', gen_random_uuid(), 1, 'old', $3, $3, 'k-' || i, 10, 'full',
                'cancelled', '{"cases":[]}', '{}', 1, now() - $4::interval, now() - $4::interval
           FROM generate_series(1, $5) i`,
        [w.team, userId, "e".repeat(64), age, n],
      );
    await insertRuns(held.id, 210, "400 days");
    await insertRuns(w.owner.id, 1, "300 days");
    const hold = await f.fx.admin.query<{ id: string }>(
      `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
      [w.team, held.id, placer.id],
    );
    await f.fx.admin.query(
      `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
      [hold.rows[0]?.id, approver.id],
    );
    const purged = await purgeSkillEvals(f.fx.db, blobs, w.team, new Date(Date.now() - 86_400_000));
    expect(purged.runs).toBe(1);
    const { rows } = await f.fx.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM skill_eval_runs WHERE team_id = $1 AND skill_name = 'old'`,
      [w.team],
    );
    expect(rows[0]?.n).toBe(210);
  });

  it("counts takeovers: the third records an error attempt, so a poison pill ends (re-review R1)", async () => {
    const w = await world();
    const provider = newProvider();
    const id = await draftWith(
      w.owner,
      "poison",
      ["cases:", "  - id: a", "    prompt: P", "    expect: {contains: Total}", ""].join("\n"),
      {},
    );
    const started = await f.on(0, w.owner).post(`/v1/skills/drafts/${id}/evals`, {
      mode: "with_only",
    });
    const evalRunId = started.json.evalRunId as string;
    const row = async () =>
      (
        await f.fx.admin.query<{
          state: string;
          attempt: number;
          takeovers: number;
          first_attempt: { status: string } | null;
          execution: { status: string } | null;
        }>(
          `SELECT state, attempt, takeovers, first_attempt, execution FROM skill_eval_results
            WHERE team_id = $1 AND eval_run_id = $2`,
          [w.team, evalRunId],
        )
      ).rows[0];
    // A replica takes it (the run is running) and dies, four times over.
    await f.fx.admin.query(`UPDATE skill_eval_runs SET status = 'running' WHERE id = $1`, [
      evalRunId,
    ]);
    for (let i = 0; i < 4; i += 1) {
      const thread = randomUUID();
      await f.fx.admin.query(
        `INSERT INTO threads (team_id, id, owner_user_id, title, skill_eval, skill_eval_run_id)
         VALUES ($1, $2, $3, 'e', true, $4)`,
        [w.team, thread, w.owner.id, evalRunId],
      );
      await f.fx.admin.query(
        `UPDATE skill_eval_results SET state = 'running', thread_id = $3,
                deadline_at = now() + interval '5 minutes', updated_at = now() - interval '5 minutes'
          WHERE team_id = $1 AND eval_run_id = $2`,
        [w.team, evalRunId, thread],
      );
      await reapSkillEvals({ db: f.fx.db, provider, runs: f.fx.replica(0).deps.runs, log: silent });
      const r = await row();
      if (i < 2) expect(r).toMatchObject({ state: "queued", attempt: 1, takeovers: i + 1 });
      if (i === 2)
        expect(r).toMatchObject({
          state: "queued",
          attempt: 2,
          first_attempt: { status: "error" },
        });
      if (i === 3) expect(r).toMatchObject({ state: "done", execution: { status: "error" } });
    }
    await closeEvals(w.team);
  });

  it("the reaper cancels the open evals of a deactivated starter (re-review R3)", async () => {
    const w = await world();
    const gone = await f.member(w.team);
    const id = await draftWith(
      gone,
      "departed",
      ["cases:", "  - id: a", "    prompt: P", "    expect: {contains: Total}", ""].join("\n"),
      {},
    );
    const started = await f.on(0, gone).post(`/v1/skills/drafts/${id}/evals`, {
      mode: "with_only",
    });
    const evalRunId = started.json.evalRunId as string;
    await f.fx.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [gone.id]);
    const provider = newProvider();
    const reaped = await reapSkillEvals({
      db: f.fx.db,
      provider,
      runs: f.fx.replica(0).deps.runs,
      log: silent,
    });
    expect(reaped.departed).toBeGreaterThanOrEqual(1);
    const { rows } = await f.fx.admin.query<{ status: string }>(
      `SELECT status FROM skill_eval_runs WHERE team_id = $1 AND id = $2`,
      [w.team, evalRunId],
    );
    expect(rows[0]?.status).toBe("cancelled");
  });

  it("an eval stream ends once the session, the account or the membership is gone (re-review R2)", async () => {
    const w = await world();
    const viewer = await f.member(w.team);
    const { rows: sessions } = await f.fx.admin.query<{ id: string }>(
      `SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [viewer.id],
    );
    const sessionId = must(sessions[0], "session").id;
    const who = { teamId: w.team, userId: viewer.id, sessionId };
    expect(await evalStreamAccess(f.fx.db, who)).toBe("member");
    await f.fx.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [viewer.id]);
    expect(await evalStreamAccess(f.fx.db, who)).toBeNull();
    await f.fx.admin.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [viewer.id]);
    await f.fx.admin.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
    expect(await evalStreamAccess(f.fx.db, who)).toBeNull();
    // An open eval's stream closes on the next check after access is gone, with no completion.
    const id = await draftWith(
      w.owner,
      "streamed",
      ["cases:", "  - id: a", "    prompt: P", "    expect: {contains: Total}", ""].join("\n"),
      {},
    );
    const started = await f.on(0, w.owner).post(`/v1/skills/drafts/${id}/evals`, {
      mode: "with_only",
    });
    let allowed = true;
    const stream = await skillEvalEventStream(
      { db: f.fx.db, hub: undefined },
      { teamId: w.team, userId: w.owner.id, role: "team_admin" },
      started.json.evalRunId as string,
      {
        pollMs: 30,
        revalidateMs: 30,
        stillAllowed: async () => (allowed ? "team_admin" : null),
      },
    );
    if (typeof stream === "string") throw new Error(stream);
    setTimeout(() => {
      allowed = false;
    }, 100);
    const text = await new Response(stream).text();
    expect(text).not.toContain("skill.eval.completed");
    await closeEvals(w.team);
  });

  it("bounds a member's open evals (review M4) and refuses a second start of the same eval (KOBE-328)", async () => {
    const w = await world();
    const suite = [
      "cases:",
      "  - id: a",
      "    prompt: P",
      "    expect: {contains: Total}",
      "",
    ].join("\n");
    const drafts: string[] = [];
    for (let i = 0; i < 4; i += 1) drafts.push(await draftWith(w.owner, `bounded-${i}`, suite, {}));
    const start = (draft: string) =>
      f.on(0, w.owner).post(`/v1/skills/drafts/${draft}/evals`, { mode: "with_only" });
    const open: string[] = [];
    for (const draft of drafts.slice(0, 3)) {
      const ok = await start(draft);
      expect(ok.status, JSON.stringify(ok.json)).toBe(202);
      open.push(ok.json.evalRunId as string);
      if (open.length === 1) {
        // The same revision and mode again (a double click): refused, nothing stored.
        const before = objects.objects.size;
        const again = await start(draft);
        expect([again.status, again.json.code]).toEqual([409, "eval_already_running"]);
        expect(objects.objects.size).toBe(before);
      }
    }
    const before = objects.objects.size;
    const refused = await start(must(drafts[3], "draft"));
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: "too_many_evals" });
    expect(objects.objects.size).toBe(before);
    // Leave nothing queued for the other tests' runners.
    for (const e of open)
      expect((await f.on(0, w.owner).post(`/v1/skill-evals/${e}/cancel`, {})).status).toBe(202);
  });

  it("never asks, and ignores the starter's remembered approvals, under a stricter floor (review L2, L12)", async () => {
    const w = await world();
    const saved = await f.fx.admin.query<{ key: string; value: string }>(
      `SELECT key, value FROM site_settings
        WHERE key IN ('policy.approval_floor', 'policy.ask_on_write.prompt_sandbox_writes')`,
    );
    await f.fx.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ('policy.approval_floor', 'ask-on-write'),
         ('policy.ask_on_write.prompt_sandbox_writes', 'true')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    try {
      const results: { decision: string; reasons: { code: string }[] }[] = [];
      const provider = newProvider();
      provider.beforeReply = async (ws, start) => {
        ws.sb.send({
          v: 1,
          type: "policy.check",
          request_id: `r-${start.run_id}`,
          run_id: start.run_id,
          thread_id: start.thread_id,
          tool_call_id: "c1",
          tool: "write",
          input: { path: "/workspace/outputs/x.txt", content: "y" },
        });
        results.push(
          await ws.sb.until(() =>
            ws.sb.frames("policy.result").find((r) => r.request_id === `r-${start.run_id}`),
          ),
        );
        expect(ws.sb.frames("policy.pending")).toEqual([]);
      };
      const cases = [
        "cases:",
        "  - id: a",
        "    prompt: Touch",
        "    expect: {contains: Total}",
        "",
      ];
      const run = async (who: Person, name: string) => {
        const id = await draftWith(who, name, cases.join("\n"), {});
        const started = await f.on(0, who).post(`/v1/skills/drafts/${id}/evals`, {
          mode: "with_only",
        });
        await drive(runnerFor(provider), w.team, started.json.evalRunId as string);
      };
      // The owner remembered "allow write forever": it allows the call in their own chats.
      await f.fx.admin.query(
        `INSERT INTO tool_rules (team_id, scope, user_id, effect, tool_glob, created_by, remember_scope)
         VALUES ($1, 'user', $2, 'allow', 'write', $2, 'forever')`,
        [w.team, w.owner.id],
      );
      await run(await f.member(w.team), "floor");
      await run(w.owner, "remembered");
      expect(results.map((r) => [r.decision, r.reasons[0]?.code])).toEqual([
        ["deny", "eval_run_no_prompt"],
        ["deny", "eval_run_no_prompt"],
      ]);
      const approvals = await f.fx.admin.query(`SELECT 1 FROM approvals WHERE team_id = $1`, [
        w.team,
      ]);
      expect(approvals.rows).toEqual([]);
      const denied = await f.fx.admin.query(
        `SELECT 1 FROM run_events WHERE team_id = $1 AND type = 'policy.denied'`,
        [w.team],
      );
      expect(denied.rows).toHaveLength(2);
    } finally {
      // Put back what was there (the test database's other files may rely on it).
      await f.fx.admin.query(
        `DELETE FROM site_settings WHERE key IN ('policy.approval_floor', 'policy.ask_on_write.prompt_sandbox_writes')`,
      );
      for (const r of saved.rows)
        await f.fx.admin.query(`INSERT INTO site_settings (key, value) VALUES ($1, $2)`, [
          r.key,
          r.value,
        ]);
    }
  });

  it("denies and records a call to the member's memory: the eval leaves nothing behind", async () => {
    const w = await world();
    const provider = newProvider();
    provider.beforeReply = async (ws, start) => {
      ws.sb.send({
        v: 1,
        type: "policy.check",
        request_id: "r1",
        run_id: start.run_id,
        thread_id: start.thread_id,
        tool_call_id: "c1",
        // The member's memory: never used by an eval (denied, recorded).
        tool: "remember",
        input: { scope: "user", path: "a.md", content: "x" },
      });
      const r = await ws.sb.until(() =>
        ws.sb.frames("policy.result").find((r) => r.request_id === "r1"),
      );
      expect(r).toMatchObject({ decision: "deny", reasons: [{ code: "eval_run_isolated" }] });
    };
    const id = await draftWith(
      w.owner,
      "denied",
      [
        "cases:",
        "  - id: a",
        "    prompt: Clean up",
        "    expect: {contains: Total, no_denied_tools: true}",
        "",
      ].join("\n"),
      {},
    );
    const started = await f.on(0, w.owner).post(`/v1/skills/drafts/${id}/evals`, {
      mode: "with_only",
    });
    const evalRunId = started.json.evalRunId as string;
    await drive(runnerFor(provider), w.team, evalRunId);
    const { rows } = await f.fx.admin.query<{ execution: Record<string, unknown> }>(
      `SELECT execution FROM skill_eval_results WHERE team_id = $1 AND eval_run_id = $2`,
      [w.team, evalRunId],
    );
    const execution = rows[0]?.execution as {
      deniedToolCalls: number;
      checks: { check: string; reason?: string }[];
    };
    expect(execution.deniedToolCalls).toBeGreaterThan(0);
    expect(execution.checks.find((c) => c.check === "no_denied_tools")?.reason).toBe("denied");
  });
});
