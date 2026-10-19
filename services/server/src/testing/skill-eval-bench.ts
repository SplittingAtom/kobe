import { randomUUID } from "node:crypto";
import pino from "pino";
import { expect } from "vitest";
import type { EvalReadResult, EvalWorkspaceSnapshot } from "@kobe/protocol";
import { seedGalleryAgents } from "../gallery/seed.js";
import { SkillEvalRunner, type SkillEvalRunnerOptions } from "../skills/evals/runner.js";
import { RawBody } from "./browser.js";
import { must, type Person } from "./event-stream-fixture.js";
import { FakeSandbox, isFake, type FakeSandboxAuth } from "./fake-sandbox.js";
import { MemoryObjects } from "./memory-objects.js";
import { FakeWorkspace, RunFixture, type RunStart } from "./run-fixture.js";

// The skill eval DB tests' bench (KOBE-325 runner, KOBE-326 judge): Postgres, the real wire, a
// scripted eval sandbox per claim, drafts with suites, and a runner driven to the end.

/** A scripted eval sandbox per claim: answers fixtures, snapshots, reads and runs as told. */
export class FakeEvalProvider {
  readonly created: string[] = [];
  readonly deleted: string[] = [];
  readonly sandboxes = new Map<string, FakeWorkspace>();
  /** Every frame any eval sandbox received, as JSON (what reached the sandboxes). */
  readonly received: string[] = [];
  live = 0;
  maxLive = 0;
  answer: (start: RunStart, attempt: number) => string = () => "Total: 42";
  beforeReply: (ws: FakeWorkspace, start: RunStart) => Promise<void> = async () => {};
  snapshot: EvalWorkspaceSnapshot = { walks: [] };
  /** The `eval.read` reply's files (default: every file read, empty). */
  read: (files: readonly { path: string; size: number }[]) => EvalReadResult["files"] = (files) =>
    files.map((f) => ({ path: f.path, status: "read", data: "", truncated: false }));
  readonly attempts = new Map<string, number>();

  constructor(
    private readonly auth: FakeSandboxAuth,
    private readonly url: () => string,
  ) {}

  createEvalSandbox = async (
    team: { id: string },
    spec: { userId: string; threadId: string; evalRunId: string; shutdownAt: Date },
  ) => {
    this.created.push(spec.threadId);
    this.live += 1;
    this.maxLive = Math.max(this.maxLive, this.live);
    const sandboxId = randomUUID();
    const token = this.auth.issue({
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
      if (frame.type === "eval.read")
        return {
          v: 1,
          type: "command.result",
          command_id: frame.command_id,
          ok: true,
          data: { files: this.read(frame.files) },
        };
      return base?.(frame);
    };
    sb.onFrame = (frame) => {
      this.received.push(JSON.stringify(frame));
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

export type SkillEvalWorld = Awaited<ReturnType<RunFixture["world"]>>;

export class SkillEvalBench {
  readonly objects = new MemoryObjects();
  readonly blobs = { objects: this.objects, prefix: "kobe/" };
  readonly f = new RunFixture();
  readonly silent = pino({ level: process.env.EVAL_TEST_LOG ?? "silent" });

  async setup(): Promise<void> {
    await this.f.setup({ blobs: this.blobs });
    await seedGalleryAgents(this.f.fx.db);
  }

  teardown(): Promise<void> {
    return this.f.teardown();
  }

  readonly url = () => must(this.f.listeners[0], "listener").url;

  provider(): FakeEvalProvider {
    return new FakeEvalProvider(this.f.auth, this.url);
  }

  /** A team with the model `fast` (provider kind `openai`), enabled and the team default. */
  async world(): Promise<SkillEvalWorld> {
    const w = await this.f.world();
    const admin = this.f.fx.admin;
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

  async put(p: Person, id: string, path: string, rev: number, body: RawBody): Promise<number> {
    const res = await this.f
      .on(0, p)
      .request("PUT", `/v1/skills/drafts/${id}/files/${path}`, body, { "if-match": `"${rev}"` });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.rev as number;
  }

  /** A draft with a SKILL.md, a suite and its fixtures. */
  async draftWith(
    p: Person,
    name: string,
    cases: string,
    fixtures: Record<string, string>,
  ): Promise<string> {
    const created = await this.f.on(0, p).post("/v1/skills/drafts", { name });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const id = created.json.draft.id as string;
    let rev = await this.put(
      p,
      id,
      "SKILL.md",
      created.json.draft.rev as number,
      text(skillMd(name)),
    );
    rev = await this.put(p, id, "evals/cases.yaml", rev, text(cases));
    for (const [path, body] of Object.entries(fixtures))
      rev = await this.put(p, id, `evals/fixtures/${path}`, rev, text(body));
    return id;
  }

  runnerFor(
    provider: FakeEvalProvider,
    maxConcurrentPerTeam = 4,
    extra: Partial<Pick<SkillEvalRunnerOptions, "judge">> = {},
  ): SkillEvalRunner {
    return new SkillEvalRunner({
      db: this.f.fx.db,
      blobs: this.blobs,
      router: this.f.fx.replica(0).deps.sandboxWire.router,
      runs: this.f.fx.replica(0).deps.runs,
      provider,
      maxConcurrentPerTeam,
      log: this.silent,
      tuning: { pollMs: 50, podWaitMs: 5_000, connectWaitMs: 5_000 },
      ...extra,
    });
  }

  async drive(runner: SkillEvalRunner, team: string, evalRunId: string): Promise<void> {
    await expect
      .poll(
        async () => {
          await runner.sweep();
          const { rows } = await this.f.fx.admin.query<{ status: string }>(
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

  /** Ends a test's open evals, so later tests' runners never pick them up. */
  closeEvals(team: string) {
    return this.f.fx.admin.query(
      `UPDATE skill_eval_runs SET status = 'cancelled', cancel_requested_at = now(), finished_at = now()
        WHERE team_id = $1 AND status IN ('queued', 'running')`,
      [team],
    );
  }
}

export const text = (t: string) => new RawBody(t, "text/plain; charset=utf-8");
export const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: Formats ${name} reports. Use when asked for a ${name} report.\n---\n# ${name}\nAdd a totals row.\n`;
