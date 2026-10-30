import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_NOTEBOOKS,
  notebookRunResponseSchema,
  type PolicyEngine,
  type ServerToSandboxFrame,
} from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { createWorkspaceSync, workspaceBlobKey } from "./workspace-sync/index.js";

/**
 * KOBE-464 end to end (docs/specs/notebooks.md): the member's `notebook` runs (NB6, NB7, NB11), the
 * agent's `run_python` (NB3, NB13) and the output intake (NB9, NB14), against a fake sandbox.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const objects = new MemoryObjects();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 4 * 1024 * 1024, maxWorkspaceBytes: 16 * 1024 * 1024, maxFiles: 50 };
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;
let sync: ReturnType<typeof createWorkspaceSync>;

const allowAll: PolicyEngine = {
  decide: () =>
    Promise.resolve({
      effect: "allow" as const,
      risk: "destructive" as const,
      reasons: [{ code: "risk_read" as const, stage: "risk_class" as const, message: "ok" }],
    }),
};

beforeAll(async () => {
  await fx.setup([{}], () => ({
    sandboxWire: {
      engine: allowAll,
      sweep: false,
      tuning: { batchWindowMs: 20, resultPollMs: 100, lostGraceMs: 0, helloTimeoutMs: 1_000 },
    },
    runs: { sweep: false },
  }));
  sync = createWorkspaceSync({ db: fx.db, objects, prefix: "", limits: LIMITS, log: silent });
  fx.replica(0).deps.notebookFiles.use(sync);
  listener = await sandboxListener(fx.replica(0).deps, auth);
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  await listener.close();
  await fx.teardown();
});

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly reader: Person;
  readonly threadId: string;
  readonly sandboxId: string;
  readonly token: string;
}

async function world(evalThread = false): Promise<World> {
  const owner = await fx.person(`u${randomBytes(2).toString("hex")}`);
  const reader = await fx.person(`r${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`nb-${randomBytes(3).toString("hex")}`, owner, [reader]);
  const threadId = randomUUID();
  await fx.admin.query(
    `INSERT INTO threads (id, team_id, owner_user_id, title, skill_eval)
     VALUES ($1, $2, $3, 'nb', $4)`,
    [threadId, team, owner.id, evalThread],
  );
  const sandboxId = randomUUID();
  return {
    team,
    owner,
    reader,
    threadId,
    sandboxId,
    token: auth.issue({ sandboxId, teamId: team, userId: owner.id }),
  };
}

type Output = Record<string, unknown>;
const stdout = (text: string): Output => ({ output_type: "stream", name: "stdout", text });
const result = (text: string, count: number): Output => ({
  output_type: "execute_result",
  execution_count: count,
  data: { "text/plain": text },
  metadata: {},
});

/** A sandbox that runs every `notebook.execute` by answering `outputs` (and records the frames). */
async function connected(
  w: World,
  outputs: (frame: Extract<ServerToSandboxFrame, { type: "notebook.execute" }>) => Output[],
  capabilities: readonly string[] = [CAPABILITY_NOTEBOOKS],
) {
  const sb = await FakeSandbox.connect(listener.url, w.token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.respond = (frame) => {
    if (frame.type === "notebook.interrupt" || frame.type === "notebook.restart") {
      return {
        v: 1,
        type: "command.result",
        command_id: frame.command_id,
        ok: true,
        data: { status: frame.type === "notebook.interrupt" ? "idle" : "restarted" },
      };
    }
    if (frame.type !== "notebook.execute") return undefined;
    const outs = outputs(frame);
    outs.forEach((output, index) =>
      sb.send({
        v: 1,
        type: "notebook.output",
        command_id: frame.command_id,
        thread_id: frame.thread_id,
        index,
        output,
      }),
    );
    return {
      v: 1,
      type: "command.result",
      command_id: frame.command_id,
      ok: true,
      data: { status: "ok", execution_count: 7, outputs: outs.length, truncated: false },
    };
  };
  sb.hello(w.sandboxId, [], undefined, capabilities);
  await sb.ready();
  return sb;
}

async function seed(w: World, path: string, content: string) {
  const data = Buffer.from(content);
  const owner = { teamId: w.team, userId: w.owner.id };
  const sha256 = createHash("sha256").update(data).digest("hex");
  objects.objects.set(workspaceBlobKey("", owner, sha256), data);
  await withTeam(fx.db, w.team, (tx) =>
    sync.putServerFile(
      tx,
      owner,
      { path, sha256, size: data.length, blobKey: workspaceBlobKey("", owner, sha256) },
      "user",
    ),
  );
  return sha256;
}

const notebook = (cells: Record<string, unknown>[]) =>
  `${JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells }, null, 1)}\n`;
const code = (id: string, source: string) => ({
  id,
  cell_type: "code",
  metadata: {},
  execution_count: null,
  outputs: [],
  source,
});

async function liveFile(w: World, path: string) {
  const { rows } = await fx.admin.query<{ sha256: string }>(
    `SELECT sha256 FROM workspace_files WHERE team_id = $1 AND user_id = $2 AND path = $3`,
    [w.team, w.owner.id, path],
  );
  const sha = must(rows[0], "file").sha256;
  const data = objects.objects.get(
    workspaceBlobKey("", { teamId: w.team, userId: w.owner.id }, sha),
  );
  return { sha, json: JSON.parse(must(data, "blob").toString("utf8")) as { cells: Output[] } };
}

async function events(team: string, runId: string) {
  const { rows } = await fx.admin.query<{ type: string; payload: Record<string, unknown> }>(
    `SELECT type, payload FROM run_events WHERE team_id = $1 AND run_id = $2 ORDER BY seq`,
    [team, runId],
  );
  return rows;
}

async function runStatus(team: string, runId: string) {
  const { rows } = await fx.admin.query<{ status: string; kind: string }>(
    `SELECT status, kind FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  return must(rows[0], "run");
}

const run = (w: World, body: unknown, who: Person = w.owner) =>
  who.browser.post(`/v1/threads/${w.threadId}/notebook/run`, body);

async function ranToEnd(w: World, body: unknown) {
  const res = await run(w, body);
  expect(res.status, JSON.stringify(res.json)).toBe(202);
  const ids = notebookRunResponseSchema.parse(res.json);
  await fx.replica(0).deps.runs.idle();
  return ids;
}

describe("the member runs a notebook cell (NB6, NB11)", () => {
  it("runs the cell's source in the thread's kernel, streams its outputs and saves them", async () => {
    const w = await world();
    const seen: string[] = [];
    await connected(w, (f) => {
      seen.push(`${f.thread_id}:${f.code}`);
      return [stdout("hello\n"), result("42", 7)];
    });
    const base = await seed(w, "nb/a.ipynb", notebook([code("c1", "print('hello')\n6 * 7")]));
    const { run_id: runId, exec_id: execId } = await ranToEnd(w, {
      path: "nb/a.ipynb",
      cell_id: "c1",
    });
    expect(seen).toEqual([`${w.threadId}:print('hello')\n6 * 7`]);
    expect(await runStatus(w.team, runId)).toEqual({ status: "completed", kind: "notebook" });
    const saved = await liveFile(w, "nb/a.ipynb");
    expect(saved.sha).not.toBe(base);
    expect(saved.json.cells[0]).toMatchObject({
      id: "c1",
      execution_count: 7,
      outputs: [
        { output_type: "stream", name: "stdout", text: ["hello\n"] },
        { output_type: "execute_result", data: { "text/plain": ["42"] } },
      ],
    });
    const types = (await events(w.team, runId)).map((e) => e.type);
    expect(types).toEqual([
      "run.started",
      "notebook.started",
      "notebook.output",
      "notebook.output",
      "notebook.finished",
      "run.completed",
    ]);
    const finished = (await events(w.team, runId)).find((e) => e.type === "notebook.finished");
    expect(finished?.payload).toEqual({
      exec_id: execId,
      status: "ok",
      execution_count: 7,
      outputs: 2,
      truncated: false,
      saved: { path: "nb/a.ipynb", sha256: saved.sha },
    });
    const thread = await fx.admin.query<{ status: string }>(
      `SELECT status FROM threads WHERE id = $1`,
      [w.threadId],
    );
    expect(thread.rows[0]?.status).toBe("idle");
  });

  it("runs a .py file whole and saves nothing", async () => {
    const w = await world();
    await connected(w, () => [stdout("ok\n")]);
    const base = await seed(w, "job.py", "print('ok')\n");
    const { run_id: runId } = await ranToEnd(w, { path: "job.py" });
    const finished = (await events(w.team, runId)).find((e) => e.type === "notebook.finished");
    expect(finished?.payload).toMatchObject({ status: "ok", outputs: 1, saved: null });
    expect((await liveFile(w, "job.py").catch(() => ({ sha: base }))).sha).toBe(base);
  });

  it("merges into the current version when the notebook changed meanwhile, if the cell is still there", async () => {
    const w = await world();
    await seed(w, "b.ipynb", notebook([code("c1", "1"), code("c2", "2")]));
    await connected(w, () => [result("1", 7)]);
    const sb = sandboxes.at(-1);
    const answer = must(sb, "sandbox").respond;
    must(sb, "sandbox").respond = (frame) => {
      if (frame.type === "notebook.execute") {
        // The member saved the notebook (another cell changed) while the cell ran.
        void seed(w, "b.ipynb", notebook([code("c1", "1"), code("c2", "2 + 2")])).then(() =>
          sb?.sendRaw(must(answer, "respond")(frame) as object),
        );
        return null;
      }
      return answer?.(frame);
    };
    const { run_id: runId } = await ranToEnd(w, { path: "b.ipynb", cell_id: "c1" });
    const saved = await liveFile(w, "b.ipynb");
    expect(saved.json.cells.map((c) => c.source)).toEqual(["1", "2 + 2"]);
    expect(saved.json.cells[0]).toMatchObject({ execution_count: 7 });
    const finished = (await events(w.team, runId)).find((e) => e.type === "notebook.finished");
    expect(finished?.payload).toMatchObject({ saved: { path: "b.ipynb", sha256: saved.sha } });
  });

  it("refuses unknown files and cells, markdown cells, other members and a busy thread", async () => {
    const w = await world();
    await connected(w, () => []);
    await seed(
      w,
      "c.ipynb",
      notebook([code("c1", "1"), { id: "m", cell_type: "markdown", metadata: {}, source: "x" }]),
    );
    await seed(w, "broken.ipynb", "{not json");
    const cases: [unknown, number, string][] = [
      [{ path: "missing.ipynb", cell_id: "c1" }, 404, "not_found"],
      [{ path: "c.ipynb", cell_id: "zz" }, 404, "cell_not_found"],
      [{ path: "c.ipynb", cell_id: "m" }, 422, "not_code_cell"],
      [{ path: "broken.ipynb", cell_id: "c1" }, 422, "not_a_notebook"],
      [{ path: "c.ipynb" }, 400, "invalid_request"],
      [{ path: "../c.ipynb", cell_id: "c1" }, 400, "invalid_request"],
    ];
    for (const [body, status, codeName] of cases) {
      const res = await run(w, body);
      expect([res.status, (res.json as { code: string }).code], JSON.stringify(body)).toEqual([
        status,
        codeName,
      ]);
    }
    await fx.activate(w.reader, w.team);
    expect((await run(w, { path: "c.ipynb", cell_id: "c1" }, w.reader)).status).toBe(404);
    await fx.admin.query(`UPDATE threads SET status = 'running' WHERE id = $1`, [w.threadId]);
    const busy = await run(w, { path: "c.ipynb", cell_id: "c1" });
    expect([busy.status, (busy.json as { code: string }).code]).toEqual([409, "thread_busy"]);
  });

  it("fails the run, recording a failed execution, when the sandbox runs no notebooks", async () => {
    const w = await world();
    await connected(w, () => [], []);
    await seed(w, "d.ipynb", notebook([code("c1", "1")]));
    const { run_id: runId } = await ranToEnd(w, { path: "d.ipynb", cell_id: "c1" });
    expect((await runStatus(w.team, runId)).status).toBe("failed");
    const finished = (await events(w.team, runId)).find((e) => e.type === "notebook.finished");
    expect(finished?.payload).toMatchObject({ status: "failed", outputs: 0, saved: null });
  });
});

describe("a notebook run whose requester died (NB6)", () => {
  it("is failed by the run sweeper once no command is in flight, freeing the thread", async () => {
    const w = await world();
    const runId = randomUUID();
    await fx.admin.query(
      `INSERT INTO runs (id, team_id, thread_id, trigger, kind, status, started_at)
       VALUES ($1, $2, $3, 'user', 'notebook', 'running', now() - interval '10 minutes')`,
      [runId, w.team, w.threadId],
    );
    await fx.admin.query(`UPDATE threads SET status = 'running' WHERE id = $1`, [w.threadId]);
    await fx.replica(0).deps.runs.sweep();
    expect((await runStatus(w.team, runId)).status).toBe("failed");
    const thread = await fx.admin.query<{ status: string }>(
      `SELECT status FROM threads WHERE id = $1`,
      [w.threadId],
    );
    expect(thread.rows[0]?.status).toBe("idle");
  });
});

describe("interrupt and restart (NB7)", () => {
  it("reach a connected sandbox, and answer no_kernel without one", async () => {
    const w = await world();
    const none = await w.owner.browser.post(`/v1/threads/${w.threadId}/notebook/interrupt`, {});
    expect([none.status, none.json]).toEqual([200, { status: "no_kernel" }]);
    const sb = await connected(w, () => []);
    const interrupt = await w.owner.browser.post(
      `/v1/threads/${w.threadId}/notebook/interrupt`,
      {},
    );
    expect([interrupt.status, interrupt.json]).toEqual([200, { status: "idle" }]);
    const restart = await w.owner.browser.post(`/v1/threads/${w.threadId}/notebook/restart`, {});
    expect([restart.status, restart.json]).toEqual([200, { status: "restarted" }]);
    expect(sb.frames("notebook.restart")).toMatchObject([{ thread_id: w.threadId }]);
    await fx.activate(w.reader, w.team);
    const other = await w.reader.browser.post(`/v1/threads/${w.threadId}/notebook/restart`, {});
    expect(other.status).toBe(404);
  });
});

describe("Stop on a notebook run (NB7, KOBE-464 review)", () => {
  it("interrupts the kernel instead of sending run.stop, and frees the thread at once", async () => {
    const w = await world();
    const sb = await connected(w, () => []);
    const answer = must(sb.respond, "respond");
    let held: Extract<ServerToSandboxFrame, { type: "notebook.execute" }> | undefined;
    sb.respond = (frame) => {
      if (frame.type === "notebook.execute") {
        held = frame;
        return null;
      }
      return answer(frame);
    };
    await seed(w, "s.ipynb", notebook([code("c1", "while True: pass")]));
    const res = await run(w, { path: "s.ipynb", cell_id: "c1" });
    expect(res.status).toBe(202);
    const { run_id: runId } = notebookRunResponseSchema.parse(res.json);
    await sb.until(() => held, 5000);
    const stop = await w.owner.browser.post(`/v1/runs/${runId}/cancel`, {});
    expect(stop.status, JSON.stringify(stop.json)).toBe(200);
    await sb.until(() => sb.frames("notebook.interrupt").length > 0, 5000);
    expect(sb.frames("notebook.interrupt")).toMatchObject([{ thread_id: w.threadId }]);
    expect(sb.frames("run.stop")).toEqual([]);
    expect((await runStatus(w.team, runId)).status).toBe("cancelled");
    // The interrupted cell's late answer ends nothing more and records nothing on the ended run.
    sb.sendRaw({
      v: 1,
      type: "command.result",
      command_id: must(held, "execute").command_id,
      ok: true,
      data: { status: "interrupted", execution_count: 1, outputs: 0, truncated: false },
    });
    await fx.replica(0).deps.runs.idle();
    expect((await runStatus(w.team, runId)).status).toBe("cancelled");
    const thread = await fx.admin.query<{ status: string }>(
      `SELECT status FROM threads WHERE id = $1`,
      [w.threadId],
    );
    expect(thread.rows[0]?.status).toBe("idle");
    const stops = await fx.admin.query<{ stop_mode: string | null }>(
      `SELECT stop_mode FROM runs WHERE id = $1`,
      [runId],
    );
    expect(stops.rows[0]?.stop_mode).toBeNull();
  });
});

describe("Stop while the sandbox wakes (KOBE-464 re-review)", () => {
  it("never delivers the cell of a stopped run once the sandbox connects", async () => {
    const w = await world();
    await seed(w, "w.ipynb", notebook([code("c1", "print('late')")]));
    const res = await run(w, { path: "w.ipynb", cell_id: "c1" });
    expect(res.status).toBe(202);
    const { run_id: runId } = notebookRunResponseSchema.parse(res.json);
    await vi.waitFor(async () => {
      const pending = await fx.admin.query<{ status: string }>(
        `SELECT status FROM sandbox_commands WHERE team_id = $1 AND run_id = $2`,
        [w.team, runId],
      );
      expect(pending.rows).toEqual([{ status: "pending" }]);
    });
    const stop = await w.owner.browser.post(`/v1/runs/${runId}/cancel`, {});
    expect(stop.status, JSON.stringify(stop.json)).toBe(200);
    const sb = await connected(w, () => [stdout("late\n")]);
    await fx.replica(0).deps.runs.idle();
    expect(sb.frames("notebook.execute")).toEqual([]);
    expect((await runStatus(w.team, runId)).status).toBe("cancelled");
  });

  it("delivery refuses a pending cell whose run already ended", async () => {
    const w = await world();
    const runId = randomUUID();
    await fx.admin.query(
      `INSERT INTO runs (id, team_id, thread_id, trigger, kind, status, started_at, ended_at)
       VALUES ($1, $2, $3, 'user', 'notebook', 'cancelled', now(), now())`,
      [runId, w.team, w.threadId],
    );
    const frame = {
      thread_id: w.threadId,
      run_id: runId,
      exec_id: randomUUID(),
      code: "print('orphan')",
      timeout_ms: 60_000,
    };
    const { rows } = await fx.admin.query<{ id: string }>(
      `INSERT INTO sandbox_commands
         (team_id, user_id, thread_id, run_id, kind, frame, requester_replica, expires_at)
       VALUES ($1, $2, $3, $4, 'notebook.execute', $5::jsonb, 'gone-replica', now() + interval '5 minutes')
       RETURNING id`,
      [w.team, w.owner.id, w.threadId, runId, JSON.stringify(frame)],
    );
    const sb = await connected(w, () => [stdout("orphan\n")]);
    const commandId = must(rows[0], "command").id;
    await vi.waitFor(async () => {
      const after = await fx.admin.query<{ status: string; result: unknown }>(
        `SELECT status, result FROM sandbox_commands WHERE id = $1`,
        [commandId],
      );
      expect(after.rows[0]).toMatchObject({
        status: "failed",
        result: { error: { code: "run_not_active" } },
      });
    }, 5000);
    expect(sb.frames("notebook.execute")).toEqual([]);
  });
});

describe("output intake (NB9, NB14)", () => {
  it("drops outputs out of order and refuses outputs for a command it did not deliver", async () => {
    const w = await world();
    const sb = await connected(w, () => []);
    sb.respond = (frame) => {
      if (frame.type !== "notebook.execute") return undefined;
      for (const index of [0, 2, 1]) {
        sb.send({
          v: 1,
          type: "notebook.output",
          command_id: frame.command_id,
          thread_id: frame.thread_id,
          index,
          output: stdout(`${index}`),
        });
      }
      return {
        v: 1,
        type: "command.result",
        command_id: frame.command_id,
        ok: true,
        data: { status: "ok", execution_count: 1, outputs: 3, truncated: false },
      };
    };
    await seed(w, "e.ipynb", notebook([code("c1", "1")]));
    const { run_id: runId } = await ranToEnd(w, { path: "e.ipynb", cell_id: "c1" });
    const outputs = (await events(w.team, runId)).filter((e) => e.type === "notebook.output");
    expect(outputs.map((e) => e.payload.index)).toEqual([0, 1]);
    sb.send({
      v: 1,
      type: "notebook.output",
      command_id: "never-issued",
      thread_id: w.threadId,
      index: 0,
      output: stdout("x"),
    });
    const closed = await sb.waitClosed();
    expect(closed.code).toBe(4007);
  });
});

describe("run_python (NB3, NB13)", () => {
  async function agentRun(w: World) {
    const runId = randomUUID();
    await fx.admin.query(
      `INSERT INTO runs (id, team_id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, $3, 'user', 'running', now())`,
      [runId, w.team, w.threadId],
    );
    await fx.admin.query(`UPDATE threads SET status = 'running' WHERE id = $1`, [w.threadId]);
    const res = await fx
      .replica(0)
      .deps.sandboxWire.router.startRun(
        { teamId: w.team, userId: w.owner.id },
        { runId, threadId: w.threadId, message: "hi" },
      );
    expect(res).toEqual({ ok: true });
    return runId;
  }

  let seq = 0;
  async function call(
    sb: FakeSandbox,
    w: World,
    runId: string,
    callId: string,
    input: Record<string, unknown>,
    check = true,
  ) {
    if (check) {
      const request_id = `c${seq++}`;
      sb.send({
        v: 1,
        type: "policy.check",
        request_id,
        run_id: runId,
        thread_id: w.threadId,
        tool_call_id: callId,
        tool: "run_python",
        input,
      });
      const decided = await sb.until(
        () => sb.frames("policy.result").find((r) => r.request_id === request_id),
        3000,
      );
      expect(decided.decision).toBe("allow");
    }
    const request_id = `n${seq++}`;
    sb.send({
      v: 1,
      type: "notebook.run",
      request_id,
      run_id: runId,
      thread_id: w.threadId,
      tool_call_id: callId,
      tool: "run_python",
      input,
    });
    return sb.until(
      () => sb.frames("notebook.run_result").find((r) => r.request_id === request_id),
      5000,
    );
  }

  it("runs code in the agent's run, streams its events and answers the model with text", async () => {
    const w = await world();
    const sb = await connected(w, (f) => [stdout(`ran ${f.code}\n`), result("2", 7)]);
    const runId = await agentRun(w);
    const answer = await call(sb, w, runId, "call-1", { code: "1 + 1" });
    expect(answer).toMatchObject({
      ok: true,
      op: "notebook_run",
      status: "ok",
      execution_count: 7,
      text: "ran 1 + 1\n2\n",
      truncated: false,
      saved: null,
    });
    const types = (await events(w.team, runId)).map((e) => e.type);
    expect(types).toEqual([
      "notebook.started",
      "notebook.output",
      "notebook.output",
      "notebook.finished",
    ]);
    const started = (await events(w.team, runId))[0];
    expect(started?.payload).toMatchObject({ origin: "agent", tool_call_id: "call-1" });
  });

  it("runs a notebook cell from the synced copy and saves its outputs", async () => {
    const w = await world();
    const sb = await connected(w, () => [result("3", 7)]);
    await seed(w, "f.ipynb", notebook([code("c1", "1 + 2")]));
    const runId = await agentRun(w);
    const answer = await call(sb, w, runId, "call-1", {
      path: "/workspace/f.ipynb",
      cell_id: "c1",
    });
    const saved = await liveFile(w, "f.ipynb");
    expect(answer).toMatchObject({ ok: true, saved: { path: "f.ipynb", sha256: saved.sha } });
    expect(sb.frames("notebook.execute")).toMatchObject([{ code: "1 + 2", run_id: runId }]);
    expect(saved.json.cells[0]).toMatchObject({ execution_count: 7 });
  });

  it("in a skill eval runs code in the eval sandbox only, never the member's files (KOBE-325)", async () => {
    const base = await world(true);
    const w: World = {
      ...base,
      token: auth.issue({
        sandboxId: base.sandboxId,
        teamId: base.team,
        userId: base.owner.id,
        evalThreadId: base.threadId,
      }),
    };
    const before = await seed(w, "private.ipynb", notebook([code("c1", "secret = 1")]));
    const sb = await connected(w, () => [result("2", 1)]);
    const runId = await agentRun(w);
    const request_id = `e${seq++}`;
    const input = { path: "private.ipynb", cell_id: "c1" };
    sb.send({
      v: 1,
      type: "policy.check",
      request_id,
      run_id: runId,
      thread_id: w.threadId,
      tool_call_id: "call-p",
      tool: "run_python",
      input,
    });
    const decided = await sb.until(
      () => sb.frames("policy.result").find((r) => r.request_id === request_id),
      3000,
    );
    expect(decided).toMatchObject({ decision: "deny" });
    expect(JSON.stringify(decided)).toContain("eval_run_isolated");
    const direct = await call(sb, w, runId, "call-p", input, false);
    expect((direct as { error?: { code: string } }).error?.code).toBe("not_allowed");
    expect(sb.frames("notebook.execute")).toEqual([]);
    expect((await liveFile(w, "private.ipynb")).sha).toBe(before);
    const ran = await call(sb, w, runId, "call-c", { code: "1 + 1" });
    expect(ran).toMatchObject({ ok: true, status: "ok", saved: null });
  });

  it("needs the capability and an allowed call with the same input, taken once", async () => {
    const w = await world();
    const sb = await connected(w, () => [stdout("x")]);
    const runId = await agentRun(w);
    const code = (r: unknown) => (r as { error?: { code: string } }).error?.code;
    expect(code(await call(sb, w, runId, "call-0", { code: "1" }, false))).toBe("not_allowed");
    expect(code(await call(sb, w, runId, "call-1", { code: "1" }))).toBeUndefined();
    expect(code(await call(sb, w, runId, "call-1", { code: "1" }, false))).toBe("not_allowed");
    const request_id = `x${seq++}`;
    sb.send({
      v: 1,
      type: "policy.check",
      request_id,
      run_id: runId,
      thread_id: w.threadId,
      tool_call_id: "call-2",
      tool: "run_python",
      input: { code: "1" },
    });
    await sb.until(() => sb.frames("policy.result").find((r) => r.request_id === request_id));
    expect(code(await call(sb, w, runId, "call-2", { code: "import os" }, false))).toBe(
      "not_allowed",
    );
    const w2 = await world();
    const old = await connected(w2, () => [], []);
    const run2 = await agentRun(w2);
    expect(code(await call(old, w2, run2, "call-1", { code: "1" }))).toBe("not_allowed");
    expect(old.frames("notebook.execute")).toEqual([]);
  });
});
