import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITY_FILE_EDITS, type PolicyEngine } from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { createWorkspaceSync, workspaceBlobKey } from "./workspace-sync/index.js";

/**
 * KOBE-484 end to end: `file.open` accepted only for a connection that announced `file_edits`, an
 * active leased run and an allowed `open_file` call with the same input, taken once. The path must
 * be a live synced file of the run owner's own workspace (read-only areas may be opened, internal
 * paths never); it reads and writes nothing and records `file.opened {tool_call_id, path}`.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const objects = new MemoryObjects();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 1024 * 1024, maxWorkspaceBytes: 4 * 1024 * 1024, maxFiles: 50 };
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;
let sync: ReturnType<typeof createWorkspaceSync>;

const allowAll: PolicyEngine = {
  decide: () =>
    Promise.resolve({
      effect: "allow" as const,
      risk: "read" as const,
      reasons: [{ code: "risk_read" as const, stage: "risk_class" as const, message: "ok" }],
    }),
};

beforeAll(async () => {
  await fx.setup([{}], () => ({
    sandboxWire: {
      engine: allowAll,
      sweep: false,
      tuning: { batchWindowMs: 20, resultPollMs: 200, lostGraceMs: 0, helloTimeoutMs: 1_000 },
    },
  }));
  sync = createWorkspaceSync({ db: fx.db, objects, prefix: "", limits: LIMITS, log: silent });
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
  readonly runId: string;
  readonly threadId: string;
  readonly sandboxId: string;
  readonly token: string;
}

async function world(): Promise<World> {
  const owner = await fx.person(`u${randomBytes(2).toString("hex")}`);
  const reader = await fx.person(`r${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`fo-${randomBytes(3).toString("hex")}`, owner, [reader]);
  const runId = await fx.run(team, owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  const sandboxId = randomUUID();
  return {
    team,
    owner,
    reader,
    runId,
    threadId: must(rows[0], "run").thread_id,
    sandboxId,
    token: auth.issue({ sandboxId, teamId: team, userId: owner.id }),
  };
}

async function started(w: World, capabilities: readonly string[] = [CAPABILITY_FILE_EDITS]) {
  const sb = await FakeSandbox.connect(listener.url, w.token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(w.sandboxId, [], "1.0.0", capabilities);
  await sb.ready();
  const res = await fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: w.team, userId: w.owner.id },
      { runId: w.runId, threadId: w.threadId, message: "hi" },
    );
  expect(res).toEqual({ ok: true });
  return sb;
}

async function seed(w: World, path: string, content: string, area: "user" | "projects" = "user") {
  const data = Buffer.from(content);
  const owner = { teamId: w.team, userId: w.owner.id };
  const sha256 = createHash("sha256").update(data).digest("hex");
  const key =
    area === "user" ? workspaceBlobKey("", owner, sha256) : `teams/${w.team}/projects/${sha256}`;
  objects.objects.set(key, data);
  await withTeam(fx.db, w.team, (tx) =>
    sync.putServerFile(tx, owner, { path, sha256, size: data.length, blobKey: key }, area),
  );
  return sha256;
}

let seq = 0;
type Input = { path: string };

async function check(sb: FakeSandbox, w: World, callId: string, input: Input) {
  const request_id = `c${seq++}`;
  sb.send({
    v: 1,
    type: "policy.check",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool: "open_file",
    input,
  });
  return sb.until(() => sb.frames("policy.result").find((r) => r.request_id === request_id), 3000);
}

async function open(sb: FakeSandbox, w: World, callId: string, input: Input) {
  const request_id = `o${seq++}`;
  sb.send({
    v: 1,
    type: "file.open",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool: "open_file",
    input,
  });
  return sb.until(
    () => sb.frames("file.open_result").find((r) => r.request_id === request_id),
    5000,
  );
}

async function allowed(sb: FakeSandbox, w: World, callId: string, input: Input) {
  expect((await check(sb, w, callId, input)).decision).toBe("allow");
  return open(sb, w, callId, input);
}

const errorCode = (r: unknown) => (r as { error?: { code: string } }).error?.code;

async function openedEvents(team: string, runId: string) {
  const { rows } = await fx.admin.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2
        AND type = 'file.opened' ORDER BY seq`,
    [team, runId],
  );
  return rows.map((r) => r.payload);
}

describe("open_file (KOBE-484, ac-1)", () => {
  it("records file.opened with the path only and answers the opened path", async () => {
    const w = await world();
    const sb = await started(w);
    const sha = await seed(w, "notes/plan.md", "# Plan\n");
    const result = await allowed(sb, w, "call-1", { path: "/workspace/notes/plan.md" });
    expect(result).toMatchObject({ ok: true, op: "file_open", path: "notes/plan.md" });
    expect(await openedEvents(w.team, w.runId)).toEqual([
      { tool_call_id: "call-1", path: "notes/plan.md" },
    ]);
    const { rows } = await fx.admin.query<{ sha256: string }>(
      `SELECT sha256 FROM workspace_files WHERE team_id = $1 AND user_id = $2 AND path = $3`,
      [w.team, w.owner.id, "notes/plan.md"],
    );
    expect(rows[0]?.sha256).toBe(sha);
  });

  it("opens read-only areas; refuses missing, internal and outside paths", async () => {
    const w = await world();
    const sb = await started(w);
    await seed(w, "projects/p/spec.md", "spec\n", "projects");
    expect(await allowed(sb, w, "call-ro", { path: "projects/p/spec.md" })).toMatchObject({
      ok: true,
      path: "projects/p/spec.md",
    });
    const cases: [string, string][] = [
      ["missing.md", "not_found"],
      [".kobe/state.md", "not_found"],
      ["/etc/passwd", "invalid_path"],
    ];
    for (const [i, [path, code]] of cases.entries()) {
      expect(errorCode(await allowed(sb, w, `call-${i}`, { path })), path).toBe(code);
    }
    expect(await openedEvents(w.team, w.runId)).toEqual([
      { tool_call_id: "call-ro", path: "projects/p/spec.md" },
    ]);
  });

  it("never opens another member's file: the owner's own workspace only", async () => {
    const w = await world();
    const sb = await started(w);
    // The same path in the reader's workspace only.
    const data = Buffer.from("theirs\n");
    const reader = { teamId: w.team, userId: w.reader.id };
    const sha256 = createHash("sha256").update(data).digest("hex");
    const key = workspaceBlobKey("", reader, sha256);
    objects.objects.set(key, data);
    await withTeam(fx.db, w.team, (tx) =>
      sync.putServerFile(
        tx,
        reader,
        { path: "theirs.md", sha256, size: data.length, blobKey: key },
        "user",
      ),
    );
    expect(errorCode(await allowed(sb, w, "call-1", { path: "theirs.md" }))).toBe("not_found");
    expect(await openedEvents(w.team, w.runId)).toEqual([]);
  });

  it("needs the capability, an allowed call with the same input, and takes it once", async () => {
    const w = await world();
    await seed(w, "a.md", "a\n");
    const old = await started(w, []);
    expect(errorCode(await allowed(old, w, "call-0", { path: "a.md" }))).toBe("not_allowed");
    old.close();

    const w2 = await world();
    await seed(w2, "a.md", "a\n");
    await seed(w2, "b.md", "b\n");
    const sb = await started(w2);
    expect(errorCode(await open(sb, w2, "call-1", { path: "a.md" }))).toBe("not_allowed");
    expect((await check(sb, w2, "call-2", { path: "a.md" })).decision).toBe("allow");
    expect(errorCode(await open(sb, w2, "call-2", { path: "b.md" }))).toBe("not_allowed");
    expect((await check(sb, w2, "call-3", { path: "a.md" })).decision).toBe("allow");
    expect((await open(sb, w2, "call-3", { path: "a.md" })).ok).toBe(true);
    expect(errorCode(await open(sb, w2, "call-3", { path: "a.md" }))).toBe("not_allowed");
    expect(await openedEvents(w2.team, w2.runId)).toHaveLength(1);
  });
});

describe("open_file in a skill eval (KOBE-325, as KOBE-464's isolation)", () => {
  it("is denied by policy and refused on the wire", async () => {
    const owner = await fx.person(`e${randomBytes(2).toString("hex")}`);
    const team = await fx.team(`fo-${randomBytes(3).toString("hex")}`, owner);
    const threadId = randomUUID();
    await fx.admin.query(
      `INSERT INTO threads (team_id, id, owner_user_id, title, status, skill_eval)
       VALUES ($1, $2, $3, 't', 'running', true)`,
      [team, threadId, owner.id],
    );
    const { rows } = await fx.admin.query<{ id: string }>(
      `INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, 'user', 'running', now()) RETURNING id`,
      [team, threadId],
    );
    const runId = must(rows[0], "run").id;
    const sandboxId = randomUUID();
    const w: World = {
      team,
      owner,
      reader: owner,
      runId,
      threadId,
      sandboxId,
      token: auth.issue({ sandboxId, teamId: team, userId: owner.id, evalThreadId: threadId }),
    };
    const sb = await started(w);
    await seed(w, "private.md", "secret\n");
    const decided = await check(sb, w, "call-1", { path: "private.md" });
    expect(decided.decision).toBe("deny");
    expect(JSON.stringify(decided)).toContain("eval_run_isolated");
    expect(errorCode(await open(sb, w, "call-1", { path: "private.md" }))).toBe("not_allowed");
    expect(await openedEvents(team, runId)).toEqual([]);
  });
});
