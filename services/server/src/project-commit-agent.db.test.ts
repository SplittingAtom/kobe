import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAPABILITY_PROJECTS,
  projectCommitResultFrameSchema,
  type PolicyDecision,
  type PolicyEngine,
} from "@kobe/protocol";
import { approvalKeyring } from "./approvals/index.js";
import { createApp } from "./app.js";
import { diffHash } from "./projects/tree.js";
import { RawBody, TestBrowser } from "./testing/browser.js";
import {
  EventStreamFixture,
  PUBLIC_URL,
  must,
  type Person,
} from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { createWorkspaceSync, type WorkspaceSync } from "./workspace-sync/index.js";

/**
 * KOBE-579 ac-3 (Workspaces CM6): the agent's `commit_project` over the wire. Approval is required
 * unless a policy rule allows the call; the approval's canonical input is built by the server and
 * binds the diff hash, so a working copy changed before the grant commits nothing; `auto` runs are
 * refused and the skip recorded; a reader's run is told `access: read` and never commits.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const objects = new MemoryObjects();
const PREFIX = "kobe/";
const KEY = approvalKeyring("approval-key-for-tests-".padEnd(48, "k"));
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;
let sync: WorkspaceSync;
let app: ReturnType<typeof createApp>;

/** What the fake engine decides for `commit_project`: a team rule allows it, or ask. */
let mode: "rule" | "ask" = "ask";
const engine: PolicyEngine = {
  decide: (): Promise<PolicyDecision> =>
    Promise.resolve(
      mode === "rule"
        ? {
            effect: "allow",
            risk: "write",
            reasons: [{ code: "team_allow_rule", stage: "user_allow", message: "ok" }],
          }
        : {
            effect: "require_approval",
            risk: "write",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            reasons: [{ code: "risk_write", stage: "risk_class", message: "a write" }],
          },
    ),
};

beforeAll(async () => {
  await fx.setup([{}], () => ({
    blobs: { objects, prefix: PREFIX },
    approvalKeys: KEY,
    approvals: { pollMs: 100 },
    sandboxWire: {
      engine,
      sweep: false,
      tuning: { batchWindowMs: 20, resultPollMs: 200, lostGraceMs: 0, helloTimeoutMs: 1_000 },
    },
  }));
  sync = createWorkspaceSync({
    db: fx.db,
    objects,
    prefix: PREFIX,
    limits: { maxFileBytes: 1024 * 1024, maxWorkspaceBytes: 4 * 1024 * 1024, maxFiles: 100 },
    log: silent,
  });
  fx.replica(0).deps.projectMounts.use(sync);
  app = createApp(fx.replica(0).deps, {
    workspaceFiles: { sync, waker: { wake: () => Promise.resolve() } },
  });
  listener = await sandboxListener(fx.replica(0).deps, auth);
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  await listener.close();
  await fx.teardown();
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function browserFor(p: Person, team: string): TestBrowser {
  const b = new TestBrowser(app, PUBLIC_URL);
  for (const [k, v] of p.browser.cookies) b.cookies.set(k, v);
  b.team = team;
  return b;
}

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly as: TestBrowser;
  readonly runId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly slug: string;
  readonly token: string;
  readonly sandboxId: string;
}

/**
 * A plain member whose thread is in a project where they hold `role` (an explicit editor row, or
 * none: every workspace member is a reader, KOBE-587); the project has
 * one file (commit 1). With `checkout`, the member has checked it out and edited `a.md`.
 */
async function world(role: "editor" | "reader", checkout = true): Promise<World> {
  const admin = await fx.person(`a${randomBytes(2).toString("hex")}`);
  const owner = await fx.person(`m${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`pc-${randomBytes(3).toString("hex")}`, admin, [owner]);
  const adminAs = browserFor(admin, team);
  const made = await adminAs.post("/v1/projects", { name: "P" });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const project = made.json as { id: string; slug: string };
  if (role === "editor") {
    expect(
      (await adminAs.post(`/v1/projects/${project.id}/members`, { user_id: owner.id, role }))
        .status,
    ).toBe(201);
  }
  const boundary = `----kobe${randomBytes(6).toString("hex")}`;
  const bytes = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.md"\r\n` +
      `Content-Type: text/plain\r\n\r\nA1\r\n--${boundary}--\r\n`,
  );
  const up = await adminAs.request(
    "POST",
    `/v1/projects/${project.id}/files`,
    new RawBody(bytes, `multipart/form-data; boundary=${boundary}`),
    { "content-length": String(bytes.length) },
  );
  expect(up.status).toBe(201);
  const runId = await fx.run(team, owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  const threadId = must(rows[0], "run").thread_id;
  await fx.admin.query(`UPDATE threads SET project_id = $3 WHERE team_id = $1 AND id = $2`, [
    team,
    threadId,
    project.id,
  ]);
  const as = browserFor(owner, team);
  if (checkout) {
    expect((await as.post(`/v1/projects/${project.id}/checkout`, {})).status).toBe(200);
    await edit(as, project.slug, sha("A1"), "A2");
  }
  const sandboxId = randomUUID();
  return {
    team,
    owner,
    as,
    runId,
    threadId,
    projectId: project.id,
    slug: project.slug,
    sandboxId,
    token: auth.issue({ sandboxId, teamId: team, userId: owner.id }),
  };
}

async function edit(as: TestBrowser, slug: string, base: string, content: string) {
  const q = new URLSearchParams({ path: `projects/${slug}/a.md`, base_sha256: base });
  const res = await as.request(
    "PUT",
    `/v1/workspace/file?${q.toString()}`,
    new RawBody(Buffer.from(content), "text/plain"),
    { "content-length": String(Buffer.byteLength(content)) },
  );
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

async function started(w: World) {
  const sb = await FakeSandbox.connect(listener.url, w.token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(w.sandboxId, [], undefined, [CAPABILITY_PROJECTS]);
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

let seq = 0;
const message = "Agent edit";

async function check(sb: FakeSandbox, w: World, callId: string) {
  const request_id = `c${seq++}`;
  sb.send({
    v: 1,
    type: "policy.check",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool: "commit_project",
    input: { message },
  });
  return sb.until(() => sb.frames("policy.result").find((r) => r.request_id === request_id), 3000);
}

async function commit(sb: FakeSandbox, w: World, callId: string) {
  const request_id = `p${seq++}`;
  sb.send({
    v: 1,
    type: "project.commit",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool: "commit_project",
    input: { message },
  });
  const res = await sb.until(
    () => sb.frames("project.commit_result").find((r) => r.request_id === request_id),
    5000,
  );
  return projectCommitResultFrameSchema.parse(res) as Record<string, any>;
}

const q = async <T>(text: string, params: unknown[]) =>
  (await fx.admin.query(text, params)).rows as T[];
const approvals = async (team: string) =>
  (
    await q<{ id: string; tool: string; input_canonical: string }>(
      `SELECT id, tool, input_canonical FROM approvals WHERE team_id = $1 ORDER BY created_at`,
      [team],
    )
  ).map((r) => ({
    id: r.id,
    tool: r.tool,
    input: JSON.parse(r.input_canonical) as Record<string, unknown>,
  }));
const commits = (projectId: string) =>
  q<{ seq: number; author_kind: string; thread_id: string | null; run_id: string | null }>(
    `SELECT seq, author_kind, thread_id, run_id FROM project_commits WHERE project_id = $1 ORDER BY seq`,
    [projectId],
  );

async function decide(p: Person, team: string, approvalId: string, decision: "allow" | "deny") {
  const res = await browserFor(p, team).post(`/v1/approvals/${approvalId}`, { decision });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

async function eventually<T>(fn: () => Promise<T | undefined | false>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("eventually timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The diff hash the server must bind: a.md modified to `content`. */
const expectedHash = (content: string) =>
  diffHash([
    {
      change: "modified",
      path: "a.md",
      before: { sha256: sha("A1"), size: 2, executable: false },
      after: { sha256: sha(content), size: Buffer.byteLength(content), executable: false },
    },
  ]);

describe("project.commit (ac-3)", () => {
  it("asks for an approval over the server's canonical input, then commits as the agent", async () => {
    mode = "ask";
    const w = await world("editor");
    const sb = await started(w);
    // The policy check leaves the approval to the server: allowed, no approval row yet.
    expect((await check(sb, w, "k1")).decision).toBe("allow");
    expect(await approvals(w.team)).toEqual([]);
    expect(await commit(sb, w, "k1")).toMatchObject({
      ok: true,
      outcome: { status: "pending_approval" },
    });
    const [approval] = await approvals(w.team);
    expect(approval?.tool).toBe("commit_project");
    expect(approval?.input).toEqual({
      project_id: w.projectId,
      base_seq: 1,
      message,
      diff_sha256: expectedHash("A2"),
    });
    // A repeat while it is pending asks nothing new.
    await check(sb, w, "k2");
    expect(await commit(sb, w, "k2")).toMatchObject({ outcome: { status: "pending_approval" } });
    expect(await approvals(w.team)).toHaveLength(1);

    await decide(w.owner, w.team, must(approval, "approval").id, "allow");
    const written = await eventually(async () => {
      const rows = await commits(w.projectId);
      return rows.length === 2 ? rows : undefined;
    });
    expect(written[1]).toEqual({
      seq: 2,
      author_kind: "agent",
      thread_id: w.threadId,
      run_id: w.runId,
    });
    const audit = await q<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'project.committed' ORDER BY seq`,
      [w.team],
    );
    expect(audit.at(-1)?.target).toMatchObject({
      seq: 2,
      authorKind: "agent",
      threadId: w.threadId,
      runId: w.runId,
    });
  });

  it("commits nothing when the working copy changed before the approval", async () => {
    mode = "ask";
    const w = await world("editor");
    const sb = await started(w);
    await check(sb, w, "c1");
    expect(await commit(sb, w, "c1")).toMatchObject({ outcome: { status: "pending_approval" } });
    await edit(w.as, w.slug, sha("A2"), "A3");
    const [approval] = await approvals(w.team);
    await decide(w.owner, w.team, must(approval, "approval").id, "allow");
    // The grant is consumed and the stale commit refused; once that call is over, a fresh call
    // (allowed by a rule now) commits the current working copy as #2: the approved one never landed.
    mode = "rule";
    let n = 0;
    const next = await eventually(async () => {
      const id = `c-next-${n++}`;
      await check(sb, w, id);
      const r = await commit(sb, w, id);
      return r.outcome?.status === "pending_approval" ? undefined : r;
    });
    expect(next).toMatchObject({ ok: true, outcome: { status: "committed", seq: 2 } });
    const consumed = await q<{ consumed_at: string | null }>(
      `SELECT consumed_at FROM approvals WHERE team_id = $1 AND tool_call_id = 'c1'`,
      [w.team],
    );
    expect(consumed[0]?.consumed_at).not.toBeNull();
  });

  it("commits at once when a policy rule allows it (no approval)", async () => {
    mode = "rule";
    const w = await world("editor");
    const sb = await started(w);
    expect((await check(sb, w, "r1")).decision).toBe("allow");
    expect(await commit(sb, w, "r1")).toMatchObject({
      ok: true,
      outcome: { status: "committed", seq: 2 },
    });
    expect(await approvals(w.team)).toEqual([]);
    // Nothing left: the next call answers nothing_to_commit.
    await check(sb, w, "r2");
    expect(await commit(sb, w, "r2")).toMatchObject({ outcome: { status: "nothing_to_commit" } });
  });

  it("is refused without the policy check, and without a checkout", async () => {
    mode = "rule";
    const w = await world("editor", false);
    const sb = await started(w);
    expect(await commit(sb, w, "u1")).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    await check(sb, w, "u2");
    expect(await commit(sb, w, "u2")).toMatchObject({
      ok: false,
      error: { code: "checkout_required" },
    });
  });

  it("refuses an auto run and records the skipped action", async () => {
    mode = "rule";
    const w = await world("editor");
    await fx.admin.query(`UPDATE runs SET approval_mode = 'auto' WHERE team_id = $1 AND id = $2`, [
      w.team,
      w.runId,
    ]);
    const sb = await started(w);
    await check(sb, w, "a1");
    const res = await commit(sb, w, "a1");
    expect(res).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(String(res.error.message)).toContain("does not wait for approvals");
    const denied = await eventually(async () => {
      const rows = await q<{ payload: { tool: string; reasons: { code: string }[] } }>(
        `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND type = 'policy.denied'`,
        [w.team, w.runId],
      );
      return rows.length > 0 ? rows : undefined;
    });
    expect(denied[0]?.payload).toMatchObject({
      tool: "commit_project",
      reasons: [{ code: "mode_auto_not_allowlisted" }],
    });
    expect((await commits(w.projectId)).map((c) => c.seq)).toEqual([1]);
  });

  // `run.start.project.access` (read for a reader, write for an editor: the sandbox registers
  // commit_project only with write) is covered in project-roles.db.test.ts (KOBE-578); here the
  // server refuses a reader's commit even when a tampered sandbox sends it.
  it("refuses a reader's commit whatever the sandbox sends", async () => {
    mode = "rule";
    const w = await world("reader", false);
    const sb = await started(w);
    await check(sb, w, "d1");
    expect(await commit(sb, w, "d1")).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect((await commits(w.projectId)).map((c) => c.seq)).toEqual([1]);
  });
});
