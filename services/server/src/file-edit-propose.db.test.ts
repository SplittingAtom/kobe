import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAPABILITY_FILE_EDITS,
  fileEditProposalsResponseSchema,
  type PolicyEngine,
} from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { createWorkspaceSync, workspaceBlobKey } from "./workspace-sync/index.js";

/**
 * KOBE-462 end to end (spec FE8, FE9): `file.edit_propose` accepted only for a connection that
 * announced `file_edits`, an active leased run and an allowed `propose_file_edit` call with the
 * same input, taken once. It writes no file: the proposal (path, base version, content, summary)
 * is the run's `file.edit_proposed` event, which the thread's owner reads back after a reload.
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
  const team = await fx.team(`fe-${randomBytes(3).toString("hex")}`, owner, [reader]);
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
type Input = { path: string; content: string; summary: string };

async function check(sb: FakeSandbox, w: World, callId: string, input: Input) {
  const request_id = `c${seq++}`;
  sb.send({
    v: 1,
    type: "policy.check",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool: "propose_file_edit",
    input,
  });
  return sb.until(() => sb.frames("policy.result").find((r) => r.request_id === request_id), 3000);
}

async function propose(sb: FakeSandbox, w: World, callId: string, input: Input) {
  const request_id = `p${seq++}`;
  sb.send({
    v: 1,
    type: "file.edit_propose",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool: "propose_file_edit",
    input,
  });
  return sb.until(
    () => sb.frames("file.edit_propose_result").find((r) => r.request_id === request_id),
    5000,
  );
}

async function allowed(sb: FakeSandbox, w: World, callId: string, input: Input) {
  expect((await check(sb, w, callId, input)).decision).toBe("allow");
  return propose(sb, w, callId, input);
}

const errorCode = (r: unknown) => (r as { error?: { code: string } }).error?.code;

async function proposalEvents(team: string, runId: string) {
  const { rows } = await fx.admin.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2
        AND type = 'file.edit_proposed' ORDER BY seq`,
    [team, runId],
  );
  return rows.map((r) => r.payload);
}

async function liveSha(w: World, path: string): Promise<string | undefined> {
  const { rows } = await fx.admin.query<{ sha256: string }>(
    `SELECT sha256 FROM workspace_files WHERE team_id = $1 AND user_id = $2 AND path = $3`,
    [w.team, w.owner.id, path],
  );
  return rows[0]?.sha256;
}

describe("propose_file_edit (KOBE-462, ac-4)", () => {
  it("records the proposal on the run and writes nothing", async () => {
    const w = await world();
    const sb = await started(w);
    const base = await seed(w, "notes/plan.md", "# Plan\n");
    const input = {
      path: "/workspace/notes/plan.md",
      content: "# Plan\n\nShip it.\n",
      summary: "Adds the last step",
    };
    const result = await allowed(sb, w, "call-1", input);
    expect(result).toMatchObject({
      ok: true,
      op: "file_edit_propose",
      status: "awaiting_user",
      path: "notes/plan.md",
      base_sha256: base,
    });
    expect(await proposalEvents(w.team, w.runId)).toEqual([
      {
        tool_call_id: "call-1",
        path: "notes/plan.md",
        base_sha256: base,
        content: input.content,
        summary: input.summary,
      },
    ]);
    expect(await liveSha(w, "notes/plan.md")).toBe(base);
  });

  it("is readable by the thread's owner after a reload, and by nobody else", async () => {
    const w = await world();
    const sb = await started(w);
    const base = await seed(w, "a.md", "a\n");
    await allowed(sb, w, "call-1", { path: "a.md", content: "b\n", summary: "b" });
    const res = await w.owner.browser.get(`/v1/threads/${w.threadId}/file-edit-proposals`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const { proposals } = fileEditProposalsResponseSchema.parse(res.json);
    expect(proposals).toMatchObject([
      {
        tool_call_id: "call-1",
        run_id: w.runId,
        path: "a.md",
        base_sha256: base,
        content: "b\n",
        summary: "b",
      },
    ]);
    await fx.activate(w.reader, w.team);
    const other = await w.reader.browser.get(`/v1/threads/${w.threadId}/file-edit-proposals`);
    expect(other.status).toBe(404);
  });

  it("refuses unknown, internal and read-only paths, and paths outside /workspace", async () => {
    const w = await world();
    const sb = await started(w);
    await seed(w, "projects/p/spec.md", "spec\n", "projects");
    const cases: [string, string][] = [
      ["missing.md", "not_found"],
      [".kobe/state.md", "not_found"],
      ["projects/p/spec.md", "read_only"],
      ["/etc/passwd", "invalid_path"],
    ];
    for (const [i, [path, code]] of cases.entries()) {
      const r = await allowed(sb, w, `call-${i}`, { path, content: "x", summary: "x" });
      expect(errorCode(r), path).toBe(code);
    }
    expect(await proposalEvents(w.team, w.runId)).toEqual([]);
  });

  it("needs the capability, an allowed call with the same input, and takes it once", async () => {
    const w = await world();
    await seed(w, "a.md", "a\n");
    const input = { path: "a.md", content: "b\n", summary: "b" };
    const old = await started(w, []);
    expect(errorCode(await allowed(old, w, "call-0", input))).toBe("not_allowed");
    old.close();

    const w2 = await world();
    await seed(w2, "a.md", "a\n");
    const sb = await started(w2);
    // Never checked.
    expect(errorCode(await propose(sb, w2, "call-1", input))).toBe("not_allowed");
    // Checked with other content.
    expect((await check(sb, w2, "call-2", input)).decision).toBe("allow");
    expect(errorCode(await propose(sb, w2, "call-2", { ...input, content: "evil\n" }))).toBe(
      "not_allowed",
    );
    // Taken once.
    expect((await check(sb, w2, "call-3", input)).decision).toBe("allow");
    expect((await propose(sb, w2, "call-3", input)).ok).toBe(true);
    expect(errorCode(await propose(sb, w2, "call-3", input))).toBe("not_allowed");
    expect(await proposalEvents(w2.team, w2.runId)).toHaveLength(1);
  });
});
