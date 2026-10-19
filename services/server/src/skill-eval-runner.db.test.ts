import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvalWorkspaceSnapshot } from "@kobe/protocol";
import { seedGalleryAgents } from "./gallery/seed.js";
import { SkillEvalRunner } from "./skills/evals/runner.js";
import { reapSkillEvals } from "./skills/evals/reaper.js";
import { purgeSkillEvals } from "./retention/skill-evals.js";
import { RawBody } from "./testing/browser.js";
import { FakeSandbox, isFake } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { RunFixture, FakeWorkspace, type RunStart } from "./testing/run-fixture.js";
import { must, type Person } from "./testing/event-stream-fixture.js";

/**
 * The skill eval runner (KOBE-325) end to end against Postgres, the real wire and a scripted eval
 * sandbox agent: a full run creates and destroys one sandbox per case per mode, the baseline loads
 * no skill and the "with" run only the eval's bundle (ac-1); the cap holds and a failing case is
 * retried once (ac-2); results are stored, scored and streamed (ac-3); eval sandboxes hold only
 * session tokens, are always deleted, and eval threads stay out of the member's lists (ac-4).
 */
const objects = new MemoryObjects();
const blobs = { objects, prefix: "kobe/" };
const f = new RunFixture();
const silent = pino({ level: process.env.EVAL_TEST_LOG ?? "silent" });
type World = Awaited<ReturnType<RunFixture["world"]>>;

/** A scripted eval sandbox per claim: answers fixtures, snapshots and runs as the test says. */
class FakeEvalProvider {
  readonly created: string[] = [];
  readonly deleted: string[] = [];
  readonly sandboxes = new Map<string, FakeWorkspace>();
  live = 0;
  maxLive = 0;
  answer: (start: RunStart, attempt: number) => string = () => "Total: 42";
  beforeReply: (ws: FakeWorkspace, start: RunStart) => Promise<void> = async () => {};
  snapshot: EvalWorkspaceSnapshot = { walks: [] };
  readonly attempts = new Map<string, number>();

  constructor(private readonly url: () => string) {}

  createEvalSandbox = async (
    team: { id: string },
    spec: { userId: string; threadId: string; evalRunId: string; shutdownAt: Date },
  ) => {
    this.created.push(spec.threadId);
    this.live += 1;
    this.maxLive = Math.max(this.maxLive, this.live);
    const sandboxId = randomUUID();
    const token = f.auth.issue({
      sandboxId,
      teamId: team.id,
      userId: spec.userId,
      evalThreadId: spec.threadId,
    });
    const sb = await FakeSandbox.connect(this.url(), token);
    if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
    sb.hello(sandboxId, [], "1.0.0", ["skill_bundles", "skill_eval"]);
    await sb.ready();
    const ws = new FakeWorkspace(sb);
    const base = sb.respond;
    sb.respond = (frame) => {
      if (frame.type === "eval.prepare")
        return { v: 1, type: "command.result", command_id: frame.command_id, ok: true };
      if (frame.type === "eval.snapshot")
        return {
          v: 1,
          type: "command.result",
          command_id: frame.command_id,
          ok: true,
          data: this.snapshot,
        };
      return base?.(frame);
    };
    sb.onFrame = (frame) => {
      if (frame.type !== "run.start") return;
      const key = frame.message;
      const n = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, n);
      setTimeout(() => {
        void this.beforeReply(ws, frame).then(() => ws.reply(frame, this.answer(frame, n)));
      }, 20);
    };
    this.sandboxes.set(spec.threadId, ws);
    return {
      sandboxId,
      namespace: "kobe-team-x",
      claimName: `e-${spec.threadId}`,
      sandboxName: "s",
      state: "running" as const,
    };
  };

  deleteEvalSandbox = async (_team: unknown, threadId: string) => {
    this.deleted.push(threadId);
    const ws = this.sandboxes.get(threadId);
    if (ws) {
      this.sandboxes.delete(threadId);
      this.live -= 1;
      ws.kill();
    }
    return true;
  };

  listEvalSandboxes = async () => [];
}

beforeAll(async () => {
  await f.setup({ blobs });
  await seedGalleryAgents(f.fx.db);
});
afterAll(async () => {
  await f.teardown();
});

const text = (t: string) => new RawBody(t, "text/plain; charset=utf-8");
const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: Formats ${name} reports. Use when asked for a ${name} report.\n---\n# ${name}\nAdd a totals row.\n`;

async function world(): Promise<World> {
  const w = await f.world();
  const admin = f.fx.admin;
  await admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1) ON CONFLICT (id) DO NOTHING`,
    [w.owner.id],
  );
  await admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by)
     VALUES ('fast', 'openai', 'fast-fake', $1) ON CONFLICT (alias) DO NOTHING`,
    [w.owner.id],
  );
  await admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'fast', true, $2)`,
    [w.team, w.owner.id],
  );
  return w;
}

async function put(p: Person, id: string, path: string, rev: number, body: RawBody) {
  const res = await f
    .on(0, p)
    .request("PUT", `/v1/skills/drafts/${id}/files/${path}`, body, { "if-match": `"${rev}"` });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.rev as number;
}

/** A draft with a SKILL.md, a suite and its fixtures. */
async function draftWith(p: Person, name: string, cases: string, fixtures: Record<string, string>) {
  const created = await f.on(0, p).post("/v1/skills/drafts", { name });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.draft.id as string;
  let rev = await put(p, id, "SKILL.md", created.json.draft.rev as number, text(skillMd(name)));
  rev = await put(p, id, "evals/cases.yaml", rev, text(cases));
  for (const [path, body] of Object.entries(fixtures))
    rev = await put(p, id, `evals/fixtures/${path}`, rev, text(body));
  return id;
}

function runnerFor(provider: FakeEvalProvider, maxConcurrentPerTeam = 4) {
  return new SkillEvalRunner({
    db: f.fx.db,
    blobs,
    router: f.fx.replica(0).deps.sandboxWire.router,
    runs: f.fx.replica(0).deps.runs,
    provider,
    maxConcurrentPerTeam,
    log: silent,
    tuning: { pollMs: 50, podWaitMs: 5_000, connectWaitMs: 5_000 },
  });
}

async function drive(runner: SkillEvalRunner, team: string, evalRunId: string) {
  await expect
    .poll(
      async () => {
        await runner.sweep();
        const { rows } = await f.fx.admin.query<{ status: string }>(
          `SELECT status FROM skill_eval_runs WHERE team_id = $1 AND id = $2`,
          [team, evalRunId],
        );
        return rows[0]?.status;
      },
      { timeout: 60_000, interval: 200 },
    )
    .toMatch(/completed|failed|cancelled/);
  await runner.idle();
}

const url = () => must(f.listeners[0], "listener").url;

/** Ends a test's open evals, so later tests' runners never pick them up. */
const closeEvals = (team: string) =>
  f.fx.admin.query(
    `UPDATE skill_eval_runs SET status = 'cancelled', cancel_requested_at = now(), finished_at = now()
      WHERE team_id = $1 AND status IN ('queued', 'running')`,
    [team],
  );

describe("skill eval runner (KOBE-325)", () => {
  it("runs a full eval: one sandbox per case per mode, baseline without skills, scored and streamed", async () => {
    const w = await world();
    const provider = new FakeEvalProvider(url);
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
    const provider = new FakeEvalProvider(url);
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
    const provider = new FakeEvalProvider(url);
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
    const provider = new FakeEvalProvider(url);
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
    const provider = new FakeEvalProvider(url);
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
    const provider = new FakeEvalProvider(url);
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
    const provider = new FakeEvalProvider(url);
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

  it("bounds a member's open evals (review M4)", async () => {
    const w = await world();
    const id = await draftWith(
      w.owner,
      "bounded",
      ["cases:", "  - id: a", "    prompt: P", "    expect: {contains: Total}", ""].join("\n"),
      {},
    );
    const open: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const ok = await f
        .on(0, w.owner)
        .post(`/v1/skills/drafts/${id}/evals`, { mode: "with_only" });
      expect(ok.status, JSON.stringify(ok.json)).toBe(202);
      open.push(ok.json.evalRunId as string);
    }
    const before = objects.objects.size;
    const refused = await f.on(0, w.owner).post(`/v1/skills/drafts/${id}/evals`, {
      mode: "with_only",
    });
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
      const provider = new FakeEvalProvider(url);
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
    const provider = new FakeEvalProvider(url);
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
