import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAPABILITY_MEMORY,
  memoryResultFrameSchema,
  runMemoryContextSchema,
  type PolicyEngine,
} from "@kobe/protocol";
import { approvalKeyring, createApprovalVerifier } from "./approvals/index.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * KOBE-156 end to end: `memory.put` / `memory.read` from a fake sandbox connection. Accepted only
 * for a connection that announced `memory`, an active leased run, and (put) a `remember` call the
 * server allowed with the same input hash; personal writes apply at once, project writes need a
 * signed approval of exactly that input, switches and membership refuse, `run.start.memory`
 * carries the enabled scopes' indexes, and nothing but ids lands in the audit log.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const objects = new MemoryObjects();
const PREFIX = "kobe/";
const KEY = approvalKeyring("approval-key-for-tests-".padEnd(48, "k"));
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;

/** When set, the policy check itself asks for approval of project writes. */
let askProject = false;
/** When set, the policy denies `recall` (a deny rule, or the agent's tool list). */
let denyRecall = false;

const engine: PolicyEngine = {
  decide: (input) => {
    const scope = (input.input as { scope?: string }).scope;
    const reasons = [
      { code: "team_allow_rule" as const, stage: "user_allow" as const, message: "ok" },
    ];
    if (denyRecall && input.tool.name === "recall") {
      return Promise.resolve({
        effect: "deny" as const,
        risk: "read" as const,
        reasons: [
          { code: "install_deny_rule" as const, stage: "install_deny" as const, message: "no" },
        ],
      });
    }
    if (askProject && input.tool.name === "remember" && scope === "project") {
      return Promise.resolve({
        effect: "require_approval" as const,
        risk: "write" as const,
        reasons,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    return Promise.resolve({ effect: "allow" as const, risk: "write" as const, reasons });
  },
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
  readonly runId: string;
  readonly threadId: string;
  readonly sandboxId: string;
  readonly token: string;
}

async function world(): Promise<World> {
  const owner = await fx.person(`m${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`mem-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  const sandboxId = randomUUID();
  return {
    team,
    owner,
    runId,
    threadId: must(rows[0], "run").thread_id,
    sandboxId,
    token: auth.issue({ sandboxId, teamId: team, userId: owner.id }),
  };
}

async function started(w: World, capabilities: readonly string[] = [CAPABILITY_MEMORY]) {
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

/** Puts the world's thread into a new project (rows by SQL, members_mode `selected`: only `join`ed users are members, team admins are not). */
async function inProject(w: World): Promise<string> {
  const id = randomUUID();
  await fx.admin.query(
    `INSERT INTO projects (team_id, id, slug, name, created_by, members_mode) VALUES ($1, $2, $3, 'P', $4, 'selected')`,
    [w.team, id, `p-${randomBytes(3).toString("hex")}`, w.owner.id],
  );
  await fx.admin.query(`UPDATE threads SET project_id = $3 WHERE team_id = $1 AND id = $2`, [
    w.team,
    w.threadId,
    id,
  ]);
  return id;
}

/** Makes the world's owner an explicit member of the thread's project (real `project_members`). */
async function join(w: World): Promise<void> {
  await fx.admin.query(
    `INSERT INTO project_members (team_id, project_id, user_id, role, added_by)
     SELECT t.team_id, t.project_id, $3, 'member', $3 FROM threads t
      WHERE t.team_id = $1 AND t.id = $2 AND t.project_id IS NOT NULL`,
    [w.team, w.threadId, w.owner.id],
  );
}

type Input = Record<string, unknown>;
let seq = 0;

async function check(sb: FakeSandbox, w: World, callId: string, input: Input, tool = "remember") {
  const request_id = `c${seq++}`;
  sb.send({
    v: 1,
    type: "policy.check",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool,
    input,
  });
  return sb.until(() => sb.frames("policy.result").find((r) => r.request_id === request_id), 3000);
}

function sendPut(sb: FakeSandbox, w: World, callId: string, input: Input): string {
  const request_id = `p${seq++}`;
  sb.send({
    v: 1,
    type: "memory.put",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    input,
  });
  return request_id;
}

async function result(sb: FakeSandbox, requestId: string) {
  const res = await sb.until(
    () => sb.frames("memory.result").find((r) => r.request_id === requestId),
    5000,
  );
  return memoryResultFrameSchema.parse(res) as Record<string, any>;
}

async function put(sb: FakeSandbox, w: World, callId: string, input: Input) {
  expect((await check(sb, w, callId, input)).decision).toBe("allow");
  return result(sb, sendPut(sb, w, callId, input));
}

/** `recall`: the policy check first (the server only reads for an allowed call), then `memory.read`. */
async function read(sb: FakeSandbox, w: World, input: Input, opts: { check?: boolean } = {}) {
  const callId = `rc${seq++}`;
  if (opts.check !== false)
    expect((await check(sb, w, callId, input, "recall")).decision).toBe("allow");
  return result(sb, sendRead(sb, w, callId, input));
}

function sendRead(sb: FakeSandbox, w: World, callId: string, input: Input): string {
  const request_id = `r${seq++}`;
  sb.send({
    v: 1,
    type: "memory.read",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    input,
  });
  return request_id;
}

const rows = async <T>(text: string, params: unknown[]) =>
  (await fx.admin.query(text, params)).rows as T[];
const docCount = async (team: string) =>
  Number(
    (
      await rows<{ n: string }>(`SELECT count(*) AS n FROM memory_docs WHERE team_id = $1`, [team])
    )[0]?.n,
  );
const updates = (w: World) =>
  rows<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND type = 'memory.updated' ORDER BY seq`,
    [w.team, w.runId],
  );

async function refusals(team: string): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 300)); // audit rows are written off the frame path
  return (
    await rows<{ target: { op: string; reason: string } }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'sandbox.memory_refused' ORDER BY seq`,
      [team],
    )
  ).map((r) => `${r.target.op}:${r.target.reason}`);
}

async function decide(p: Person, approvalId: string, decision: "allow" | "deny") {
  const res = await fx.replica(0).app.request(`http://kobe.test/v1/approvals/${approvalId}`, {
    method: "POST",
    headers: {
      cookie: [...p.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      origin: "http://kobe.test",
      "content-type": "application/json",
      "x-forwarded-for": p.browser.ip,
      ...(p.browser.team ? { "x-kobe-team": p.browser.team } : {}),
    },
    body: JSON.stringify({ decision }),
  });
  expect(res.status).toBe(200);
}

const setTeamSwitches = async (w: World, body: Record<string, boolean>) => {
  const res = await w.owner.browser.put("/v1/memory/settings?level=team", body);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
};

/** Polls an async condition (the sandbox's `until` takes sync predicates only). */
async function eventually<T>(fn: () => Promise<T | undefined | false>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("eventually timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const errorCode = (r: Record<string, any>) => r.error?.code;

describe("memory.put / memory.read: personal memory", () => {
  it("remember and recall work end to end, with Undo data, audit and no content in the audit log", async () => {
    const w = await world();
    const sb = await started(w);

    const first = await put(sb, w, "t1", { scope: "user", path: "prefs.md", content: "likes tea" });
    expect(first).toMatchObject({
      ok: true,
      op: "put",
      status: "applied",
      scope: "user",
      version: 1,
    });
    expect(first.previous_version).toBeUndefined();
    const second = await put(sb, w, "t2", {
      scope: "user",
      path: "prefs.md",
      content: "and coffee",
      mode: "append",
    });
    expect(second).toMatchObject({ status: "applied", version: 2, previous_version: 1 });

    const file = await read(sb, w, { scope: "user", path: "prefs.md" });
    expect(file).toMatchObject({ ok: true, op: "read", truncated: false });
    expect(file.files).toEqual([
      { scope: "user", path: "prefs.md", content: "likes tea\nand coffee", version: 2 },
    ]);
    await put(sb, w, "t3", { scope: "user", path: "MEMORY.md", content: "- [prefs](prefs.md)" });
    const listed = await read(sb, w, {});
    expect(listed.files.map((f: { path: string }) => f.path)).toEqual(["MEMORY.md", "prefs.md"]);
    expect(listed.files[0].content).toBeUndefined();
    const found = await read(sb, w, { query: "COFFEE" });
    expect(found.files.map((f: { path: string }) => f.path)).toEqual(["prefs.md"]);
    expect(errorCode(await read(sb, w, { scope: "user", path: "nope.md" }))).toBe("not_found");

    // Events carry what Undo needs, tied to the tool call.
    const ev = await updates(w);
    expect(ev.map((e) => e.payload)).toMatchObject([
      { scope: "user", path: "prefs.md", version: 1, tool_call_id: "t1", mode: "replace" },
      { scope: "user", version: 2, previous_version: 1, tool_call_id: "t2", mode: "append" },
      { path: "MEMORY.md", version: 1, tool_call_id: "t3" },
    ]);
    // The panel sees the same doc; the version is the agent's.
    const detail = (await w.owner.browser.get("/v1/memory?scope=user")).json as {
      docs: { path: string; current_version: number }[];
    };
    expect(detail.docs.map((d) => [d.path, d.current_version]).sort()).toEqual([
      ["MEMORY.md", 1],
      ["prefs.md", 2],
    ]);
    const versions = await rows<{ actor_kind: string; tool_call_id: string; run_id: string }>(
      `SELECT actor_kind, tool_call_id, run_id FROM memory_doc_versions WHERE team_id = $1 ORDER BY created_at`,
      [w.team],
    );
    expect(versions[0]).toMatchObject({ actor_kind: "agent", tool_call_id: "t1", run_id: w.runId });

    const audits = await rows<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'memory.written' ORDER BY seq`,
      [w.team],
    );
    expect(audits).toHaveLength(3);
    expect(audits[0]?.target).toMatchObject({ scope: "user", actorKind: "agent", version: 1 });
    expect(JSON.stringify(audits)).not.toMatch(/tea|coffee|prefs/);
  });

  it("is idempotent on the tool call id", async () => {
    const w = await world();
    const sb = await started(w);
    const input = { scope: "user", path: "a.md", content: "one" };
    const first = await put(sb, w, "same", input);
    const again = await result(sb, sendPut(sb, w, "same", input));
    expect(again).toMatchObject({ status: "applied", version: first.version });
    expect(
      (await rows(`SELECT 1 FROM memory_doc_versions WHERE team_id = $1`, [w.team])).length,
    ).toBe(1);
    expect(await updates(w)).toHaveLength(1);
  });

  it("refuses without the capability, an unallowed call, a changed input and an ended run", async () => {
    const w = await world();
    const sb = await started(w, []);
    const input = { scope: "user", path: "a.md", content: "x" };
    expect(errorCode(await result(sb, sendPut(sb, w, "c0", input)))).toBe("not_allowed");
    expect(errorCode(await read(sb, w, {}))).toBe("not_allowed");

    const w2 = await world();
    const sb2 = await started(w2);
    // Never allowed by a policy check.
    expect(errorCode(await result(sb2, sendPut(sb2, w2, "ghost", input)))).toBe("not_allowed");
    // Allowed for one input, sent with another.
    expect((await check(sb2, w2, "c1", input)).decision).toBe("allow");
    const forged = { ...input, content: "something else" };
    expect(errorCode(await result(sb2, sendPut(sb2, w2, "c1", forged)))).toBe("not_allowed");
    // Allowed, then the run ends.
    expect((await check(sb2, w2, "c2", input)).decision).toBe("allow");
    await fx.complete(w2.team, w2.runId);
    const late = await result(sb2, sendPut(sb2, w2, "c2", input));
    expect(errorCode(late)).toBe("not_allowed");
    expect(await docCount(w2.team)).toBe(0);
    expect(await docCount(w.team)).toBe(0);
    expect(await refusals(w2.team)).toEqual(
      expect.arrayContaining(["put:not_allowed", "put:input_mismatch", "put:run_not_active"]),
    );
    expect(await refusals(w.team)).toEqual(
      expect.arrayContaining(["put:capability_missing", "read:capability_missing"]),
    );
  });

  it("refuses an oversized index and returns the store's codes", async () => {
    const w = await world();
    const sb = await started(w);
    const lines = Array(150).fill("- l").join("\n");
    await put(sb, w, "i1", { scope: "user", path: "MEMORY.md", content: lines });
    const full = await put(sb, w, "i2", {
      scope: "user",
      path: "MEMORY.md",
      content: lines,
      mode: "append",
    });
    expect(errorCode(full)).toBe("index_full");
    expect(await updates(w)).toHaveLength(1);
  });
});

describe("recall is bound to the policy check (D-3)", () => {
  it("a recall that policy denied, never checked or changed is refused", async () => {
    const w = await world();
    const sb = await started(w);
    await put(sb, w, "k1", { scope: "user", path: "a.md", content: "secret" });
    // Never checked.
    const ghost = await result(sb, sendRead(sb, w, "ghost", {}));
    expect(errorCode(ghost)).toBe("not_allowed");
    // Checked for one input, sent with another.
    expect((await check(sb, w, "rc-x", { query: "none" }, "recall")).decision).toBe("allow");
    expect(errorCode(await result(sb, sendRead(sb, w, "rc-x", { query: "secret" })))).toBe(
      "not_allowed",
    );
    // Denied by policy.
    denyRecall = true;
    try {
      expect((await check(sb, w, "rc-d", {}, "recall")).decision).toBe("deny");
    } finally {
      denyRecall = false;
    }
    const denied = await result(sb, sendRead(sb, w, "rc-d", {}));
    expect(errorCode(denied)).toBe("not_allowed");
    expect(JSON.stringify(denied)).not.toContain("secret");
    expect(await refusals(w.team)).toEqual(
      expect.arrayContaining(["read:not_allowed", "read:input_mismatch"]),
    );
  });
});

describe("switches", () => {
  it("a disabled scope answers memory_disabled and is left out of run.start.memory", async () => {
    const w = await world();
    await setTeamSwitches(w, { memory_enabled: false });
    const sb = await started(w);
    const start = sb.frames("run.start")[0] as { memory?: unknown } | undefined;
    expect(runMemoryContextSchema.parse(start?.memory)).toEqual({ scopes: [], indexes: [] });
    const refused = await put(sb, w, "d1", { scope: "user", path: "a.md", content: "x" });
    expect(errorCode(refused)).toBe("memory_disabled");
    expect(errorCode(await read(sb, w, { scope: "user" }))).toBe("memory_disabled");
    expect(await docCount(w.team)).toBe(0);
    expect(await refusals(w.team)).toContain("put:memory_disabled");
  });

  it("the install switch is ANDed with the team's", async () => {
    const w = await world();
    const sb = await started(w);
    await fx.admin.query(
      `INSERT INTO install_settings (key, value) VALUES ('memory.enabled', 'false')
       ON CONFLICT (key) DO UPDATE SET value = 'false'`,
    );
    try {
      const refused = await put(sb, w, "d1", { scope: "user", path: "a.md", content: "x" });
      expect(errorCode(refused)).toBe("memory_disabled");
    } finally {
      await fx.admin.query(`DELETE FROM install_settings WHERE key = 'memory.enabled'`);
    }
    const ok = await put(sb, w, "d2", { scope: "user", path: "a.md", content: "x" });
    expect(ok.status).toBe("applied");
  });
});

describe("run.start.memory", () => {
  it("carries the indexes of the enabled scopes, only for agents with the capability", async () => {
    const w = await world();
    const first = await started(w);
    await put(first, w, "x1", { scope: "user", path: "MEMORY.md", content: "- tea\n- coffee" });
    first.close();

    // A new run of the same user sees the stored index.
    const w2 = { ...w, runId: await fx.run(w.team, w.owner), sandboxId: randomUUID() };
    const { rows: t } = await fx.admin.query<{ thread_id: string }>(
      `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
      [w.team, w2.runId],
    );
    const world2 = {
      ...w2,
      threadId: must(t[0], "thread").thread_id,
      token: auth.issue({ sandboxId: w2.sandboxId, teamId: w.team, userId: w.owner.id }),
    };
    const sb = await started(world2);
    const start = sb.frames("run.start")[0] as { memory?: unknown } | undefined;
    expect(runMemoryContextSchema.parse(start?.memory)).toEqual({
      scopes: ["user"],
      indexes: [{ scope: "user", content: "- tea\n- coffee", version: 1, truncated: false }],
    });

    const w3 = await world();
    const old = await started(w3, []);
    expect(old.frames("run.start")[0]).not.toHaveProperty("memory");
  });

  it("lists project only for a member of the thread's project, with its index", async () => {
    const w = await world();
    const projectId = await inProject(w);
    await join(w);
    const sb0 = await started(w);
    const start = sb0.frames("run.start")[0] as { memory?: unknown } | undefined;
    expect(runMemoryContextSchema.parse(start?.memory)).toEqual({
      scopes: ["user", "project"],
      indexes: [
        { scope: "user", content: "", version: 0, truncated: false },
        { scope: "project", content: "", version: 0, truncated: false },
      ],
    });
    expect(projectId).toBeTruthy();

    const w2 = await world();
    await inProject(w2);
    const sb = await started(w2);
    const memory = runMemoryContextSchema.parse(
      (sb.frames("run.start")[0] as { memory?: unknown } | undefined)?.memory,
    );
    expect(memory.scopes).toEqual(["user"]);

    const w3 = await world();
    await inProject(w3);
    await join(w3);
    await setTeamSwitches(w3, { project_memory_enabled: false });
    const sb3 = await started(w3);
    expect(
      runMemoryContextSchema.parse(
        (sb3.frames("run.start")[0] as { memory?: unknown } | undefined)?.memory,
      ).scopes,
    ).toEqual(["user"]);
  });
});

describe("project memory", () => {
  const input = { scope: "project", path: "decisions.md", content: "use pnpm" };

  it("waits for a signed approval, then applies and emits memory.updated", async () => {
    const w = await world();
    await inProject(w);
    await join(w);
    const sb = await started(w);
    expect((await check(sb, w, "p1", input)).decision).toBe("allow");
    const reqId = sendPut(sb, w, "p1", input);
    const pending = await result(sb, reqId);
    expect(pending).toMatchObject({ ok: true, status: "pending_approval", scope: "project" });
    expect(await docCount(w.team)).toBe(0);

    const [approval] = await rows<{ id: string; tool: string; status: string }>(
      `SELECT id, tool, status FROM approvals WHERE team_id = $1 AND run_id = $2`,
      [w.team, w.runId],
    );
    expect(approval).toMatchObject({ tool: "remember", status: "pending" });
    await decide(w.owner, must(approval, "approval").id, "allow");

    await eventually(async () => (await docCount(w.team)) === 1);
    const ev = await eventually(async () => {
      const found = await updates(w);
      return found.length > 0 ? found : undefined;
    });
    expect(ev[0]?.payload).toMatchObject({
      scope: "project",
      path: "decisions.md",
      version: 1,
      tool_call_id: "p1",
    });
    const consumed = await rows<{ target: { enforcementPoint: string } }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'approval.consumed'`,
      [w.team],
    );
    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.target.enforcementPoint).toBe("server");
    // A repeat of the applied call answers its version; the approval is not reused.
    expect(await result(sb, sendPut(sb, w, "p1", input))).toMatchObject({
      status: "applied",
      version: 1,
    });
  });

  it("a denied approval writes nothing", async () => {
    const w = await world();
    await inProject(w);
    await join(w);
    const sb = await started(w);
    await check(sb, w, "p2", input);
    expect(await result(sb, sendPut(sb, w, "p2", input))).toMatchObject({
      status: "pending_approval",
    });
    const [approval] = await rows<{ id: string }>(
      `SELECT id FROM approvals WHERE team_id = $1 AND run_id = $2`,
      [w.team, w.runId],
    );
    await decide(w.owner, must(approval, "approval").id, "deny");
    expect(await refusals(w.team)).toContain("put:approval_denied");
    expect(await docCount(w.team)).toBe(0);
    expect(await updates(w)).toHaveLength(0);
  });

  it("applies at once when the policy check already got the signed approval, and only for that input", async () => {
    const w = await world();
    await inProject(w);
    await join(w);
    const sb = await started(w);
    askProject = true;
    try {
      const requestId = `c${seq++}`;
      sb.send({
        v: 1,
        type: "policy.check",
        request_id: requestId,
        run_id: w.runId,
        thread_id: w.threadId,
        tool_call_id: "p3",
        tool: "remember",
        input,
      });
      const pending = await sb.until(
        () => sb.frames("policy.pending").find((f) => f.request_id === requestId),
        3000,
      );
      await decide(w.owner, String(pending.approval_id), "allow");
      const allowed = await sb.until(
        () => sb.frames("policy.result").find((f) => f.request_id === requestId),
        3000,
      );
      expect(allowed.decision).toBe("allow");
    } finally {
      askProject = false;
    }
    // Sending other content than the approved one is refused: the policy allow binds the hash.
    const forged = await result(sb, sendPut(sb, w, "p3", { ...input, content: "rm -rf" }));
    expect(errorCode(forged)).toBe("not_allowed");
    expect(await docCount(w.team)).toBe(0);
    const ok = await result(sb, sendPut(sb, w, "p3", input));
    expect(ok).toMatchObject({ ok: true, status: "applied", scope: "project", version: 1 });
    expect(await docCount(w.team)).toBe(1);
    // One approval was asked for, none new for the put.
    expect((await rows(`SELECT 1 FROM approvals WHERE team_id = $1`, [w.team])).length).toBe(1);
  });

  it.each([
    ["auto approval mode", `UPDATE runs SET approval_mode = 'auto'`, "mode_auto_not_allowlisted"],
    ["a scheduled run", `UPDATE runs SET trigger = 'schedule'`, "scheduled_run_no_prompt"],
  ])(
    "%s never waits: the project write is denied at once and reported",
    async (_n, update, code) => {
      const w = await world();
      await inProject(w);
      await join(w);
      await fx.admin.query(`${update} WHERE team_id = $1 AND id = $2`, [w.team, w.runId]);
      const sb = await started(w);
      await check(sb, w, "a1", input);
      const res = await result(sb, sendPut(sb, w, "a1", input));
      expect(errorCode(res)).toBe("not_allowed");
      expect(res.status).toBeUndefined();
      expect((await rows(`SELECT 1 FROM approvals WHERE team_id = $1`, [w.team])).length).toBe(0);
      expect(await docCount(w.team)).toBe(0);
      const denied = await rows<{ payload: { tool: string; reasons: { code: string }[] } }>(
        `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND type = 'policy.denied'`,
        [w.team, w.runId],
      );
      expect(denied[0]?.payload).toMatchObject({ tool: "remember", reasons: [{ code }] });
      // Personal memory is not an approval matter: it still applies.
      expect((await put(sb, w, "a2", { scope: "user", path: "a.md", content: "x" })).status).toBe(
        "applied",
      );
    },
  );

  it("uses the effective mode: an install floor above the run's own `auto` still asks", async () => {
    const w = await world();
    await inProject(w);
    await join(w);
    await fx.admin.query(`UPDATE runs SET approval_mode = 'auto' WHERE team_id = $1 AND id = $2`, [
      w.team,
      w.runId,
    ]);
    await fx.admin.query(
      `INSERT INTO install_settings (key, value) VALUES ('policy.approval_floor', 'ask-on-write')
       ON CONFLICT (key) DO UPDATE SET value = 'ask-on-write'`,
    );
    try {
      const sb = await started(w);
      await check(sb, w, "f1", input);
      expect(await result(sb, sendPut(sb, w, "f1", input))).toMatchObject({
        status: "pending_approval",
      });
    } finally {
      await fx.admin.query(`DELETE FROM install_settings WHERE key = 'policy.approval_floor'`);
    }
  });

  it("an approval is single use and bound to its input", async () => {
    const w = await world();
    await inProject(w);
    await join(w);
    const sb = await started(w);
    askProject = true;
    try {
      const requestId = `c${seq++}`;
      sb.send({
        v: 1,
        type: "policy.check",
        request_id: requestId,
        run_id: w.runId,
        thread_id: w.threadId,
        tool_call_id: "s1",
        tool: "remember",
        input,
      });
      const pending = await sb.until(
        () => sb.frames("policy.pending").find((f) => f.request_id === requestId),
        3000,
      );
      await decide(w.owner, String(pending.approval_id), "allow");
      await sb.until(
        () => sb.frames("policy.result").find((f) => f.request_id === requestId),
        3000,
      );
    } finally {
      askProject = false;
    }
    const verifier = createApprovalVerifier({ db: fx.db, keys: KEY });
    const call = {
      teamId: w.team,
      userId: w.owner.id,
      runId: w.runId,
      toolCallId: "s1",
      tool: "remember",
    };
    // Another input hash: refused, and the approval is still unspent.
    expect((await verifier.authorize({ ...call, input: { ...input, content: "other" } })).ok).toBe(
      false,
    );
    // The handler spends it exactly once.
    expect(await result(sb, sendPut(sb, w, "s1", input))).toMatchObject({ status: "applied" });
    expect((await verifier.authorize({ ...call, input })).ok).toBe(false);
    // A replayed memory.put answers the stored version and writes nothing more.
    expect(await result(sb, sendPut(sb, w, "s1", input))).toMatchObject({
      status: "applied",
      version: 1,
    });
    expect(
      (await rows(`SELECT 1 FROM memory_doc_versions WHERE team_id = $1`, [w.team])).length,
    ).toBe(1);
  });

  it("refuses non-members, threads outside a project and a disabled project scope", async () => {
    const stranger = await world();
    await inProject(stranger); // owner is not in `members`
    const sbS = await started(stranger);
    await check(sbS, stranger, "n1", input);
    expect(errorCode(await result(sbS, sendPut(sbS, stranger, "n1", input)))).toBe("not_allowed");
    expect(errorCode(await read(sbS, stranger, { scope: "project" }))).toBe("not_allowed");
    expect(await refusals(stranger.team)).toEqual(
      expect.arrayContaining(["put:not_a_member", "read:not_a_member"]),
    );
    expect((await rows(`SELECT 1 FROM approvals WHERE team_id = $1`, [stranger.team])).length).toBe(
      0,
    );

    const loose = await world();
    await join(loose);
    const sbL = await started(loose);
    await check(sbL, loose, "n2", input);
    expect(errorCode(await result(sbL, sendPut(sbL, loose, "n2", input)))).toBe("not_allowed");
    expect(await refusals(loose.team)).toContain("put:no_project");

    const off = await world();
    await inProject(off);
    await join(off);
    await setTeamSwitches(off, { project_memory_enabled: false });
    const sbO = await started(off);
    await check(sbO, off, "n3", input);
    expect(errorCode(await result(sbO, sendPut(sbO, off, "n3", input)))).toBe("memory_disabled");
    // Personal memory still works while project memory is off.
    const personal = await put(sbO, off, "n4", { scope: "user", path: "a.md", content: "x" });
    expect(personal.status).toBe("applied");
  });

  it("members read project memory", async () => {
    const w = await world();
    await inProject(w);
    await join(w);
    const sb = await started(w);
    await check(sb, w, "r1", input);
    expect((await result(sb, sendPut(sb, w, "r1", input))).status).toBe("pending_approval");
    const [approval] = await rows<{ id: string }>(`SELECT id FROM approvals WHERE team_id = $1`, [
      w.team,
    ]);
    await decide(w.owner, must(approval, "approval").id, "allow");
    await eventually(async () => (await docCount(w.team)) === 1);
    const found = await read(sb, w, { query: "pnpm" });
    expect(found.files).toEqual([
      { scope: "project", path: "decisions.md", content: "use pnpm", version: 1 },
    ]);
  });
});
