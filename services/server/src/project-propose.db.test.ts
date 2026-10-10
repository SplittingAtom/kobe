import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITY_PROJECTS, projectFileProposeResultFrameSchema } from "@kobe/protocol";
import type { PolicyEngine } from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { approvalKeyring } from "./approvals/index.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { createWorkspaceSync, type WorkspaceSync } from "./workspace-sync/index.js";
import { listLive } from "./workspace-sync/store.js";

/**
 * KOBE-162 (ac-2): `project.file_propose` from a fake sandbox connection. Accepted only for a
 * connection that announced `projects`, an active leased run and a `propose_project_file` call the
 * server allowed with the same input hash; the thread's project and the user's membership are
 * re-checked; the add needs the signed approval of exactly that input; the bytes are the
 * workspace manifest's own object, copied server-side; everything refused is audited.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const objects = new MemoryObjects();
const PREFIX = "kobe/";
const KEY = approvalKeyring("approval-key-for-tests-".padEnd(48, "k"));
const LIMITS = { maxFileBytes: 1024 * 1024, maxWorkspaceBytes: 4 * 1024 * 1024, maxFiles: 100 };
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;
let sync: WorkspaceSync;

const engine: PolicyEngine = {
  decide: () =>
    Promise.resolve({
      effect: "allow" as const,
      risk: "write" as const,
      reasons: [{ code: "team_allow_rule" as const, stage: "user_allow" as const, message: "ok" }],
    }),
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
    limits: LIMITS,
    log: silent,
  });
  fx.replica(0).deps.projectMounts.use(sync);
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
  projectId?: string;
  slug?: string;
}

async function world(): Promise<World> {
  const owner = await fx.person(`m${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`prj-${randomBytes(3).toString("hex")}`, owner);
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

async function started(w: World, capabilities: readonly string[] = [CAPABILITY_PROJECTS]) {
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

/** The thread's project; `members_mode` selected, so only joined users are members (admins are not). */
async function inProject(w: World, join = true): Promise<void> {
  const id = randomUUID();
  const slug = `p-${randomBytes(3).toString("hex")}`;
  await fx.admin.query(
    `INSERT INTO projects (team_id, id, slug, name, created_by, members_mode) VALUES ($1, $2, $3, 'P', $4, 'selected')`,
    [w.team, id, slug, w.owner.id],
  );
  await fx.admin.query(`UPDATE threads SET project_id = $3 WHERE team_id = $1 AND id = $2`, [
    w.team,
    w.threadId,
    id,
  ]);
  if (join) {
    await fx.admin.query(
      `INSERT INTO project_members (team_id, project_id, user_id, role, added_by) VALUES ($1, $2, $3, 'member', $3)`,
      [w.team, id, w.owner.id],
    );
  }
  w.projectId = id;
  w.slug = slug;
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** A file the sandbox pushed: the manifest row and its object, as workspace sync leaves them. */
async function pushed(w: World, path: string, content: string) {
  const data = Buffer.from(content);
  const hash = sha(data);
  const blobKey = `${PREFIX}teams/${w.team}/users/${w.owner.id}/workspace/${hash}`;
  objects.objects.set(blobKey, data);
  const entry = await withTeam(fx.db, w.team, (tx) =>
    sync.putServerFile(
      tx,
      { teamId: w.team, userId: w.owner.id },
      { path, sha256: hash, size: data.length, blobKey },
      "user",
    ),
  );
  return { path, rev: entry.rev, sha256: hash, size: data.length };
}

type Input = Record<string, unknown>;
let seq = 0;

async function check(sb: FakeSandbox, w: World, callId: string, input: Input) {
  const request_id = `c${seq++}`;
  sb.send({
    v: 1,
    type: "policy.check",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool: "propose_project_file",
    input,
  });
  return sb.until(() => sb.frames("policy.result").find((r) => r.request_id === request_id), 3000);
}

async function propose(
  sb: FakeSandbox,
  w: World,
  callId: string,
  input: Input,
  workspace: { path: string; rev: number; sha256: string; size: number },
) {
  const request_id = `p${seq++}`;
  sb.send({
    v: 1,
    type: "project.file_propose",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool: "propose_project_file",
    input,
    workspace,
  });
  const res = await sb.until(
    () => sb.frames("project.file_propose_result").find((r) => r.request_id === request_id),
    5000,
  );
  return projectFileProposeResultFrameSchema.parse(res) as Record<string, any>;
}

const rows = async <T>(text: string, params: unknown[]) =>
  (await fx.admin.query(text, params)).rows as T[];
const fileRows = (team: string) =>
  rows<{ path: string; source: string; blob_ref: string; added_by: string; sha256: string }>(
    `SELECT path, source, blob_ref, added_by, sha256 FROM project_files WHERE team_id = $1 ORDER BY path`,
    [team],
  );
const approvals = (team: string) =>
  rows<{ id: string; tool: string }>(`SELECT id, tool FROM approvals WHERE team_id = $1`, [team]);

async function refusals(team: string): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 300)); // audit rows are written off the frame path
  return (
    await rows<{ target: { reason: string } }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'sandbox.project_file_refused' ORDER BY seq`,
      [team],
    )
  ).map((r) => r.target.reason);
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

describe("project.file_propose (ac-2)", () => {
  const input = { path: "notes/spec.md", folder: "docs", reason: "keep the spec" };

  it("needs a signed approval, then copies the blob server-side and mounts it for members", async () => {
    const w = await world();
    await inProject(w);
    const sb = await started(w);
    const ref = await pushed(w, "notes/spec.md", "# spec\n");
    expect((await check(sb, w, "f1", input)).decision).toBe("allow");

    const pending = await propose(sb, w, "f1", input, ref);
    expect(pending).toMatchObject({
      ok: true,
      status: "pending_approval",
      project_id: w.projectId,
      path: "docs/spec.md",
    });
    expect(await fileRows(w.team)).toEqual([]);

    const [approval] = await approvals(w.team);
    expect(approval?.tool).toBe("propose_project_file");
    await decide(w.owner, must(approval, "approval").id, "allow");
    const added = await eventually(async () => {
      const found = await fileRows(w.team);
      return found.length > 0 ? found : undefined;
    });
    expect(added[0]).toMatchObject({
      path: "docs/spec.md",
      source: "proposal",
      added_by: w.owner.id,
      sha256: ref.sha256,
    });
    // Copied server-side into the project's own key, byte for byte; the workspace object stays.
    const key = must(added[0], "row").blob_ref;
    expect(key).toBe(
      `${PREFIX}teams/${w.team}/projects/${w.projectId}/files/${key.split("/").at(-1)}`,
    );
    expect(objects.objects.get(key)?.toString()).toBe("# spec\n");
    // The member's workspace names it, read-only area, origin server.
    const mounted = await eventually(async () => {
      const found = await withTeam(fx.db, w.team, (tx) =>
        listLive(tx, { teamId: w.team, userId: w.owner.id }, "projects/", 100),
      );
      return found.length > 0 ? found : undefined;
    });
    expect(mounted.map((e) => [e.path, e.origin, e.blobKey])).toEqual([
      [`projects/${w.slug}/docs/spec.md`, "server", key],
    ]);
    // Audited: the signed approval was consumed by the server, the add names no file.
    const consumed = await rows<{ target: { enforcementPoint: string } }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'approval.consumed'`,
      [w.team],
    );
    expect(consumed.map((c) => c.target.enforcementPoint)).toEqual(["server"]);
    const addedAudit = await rows<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'project.file_added'`,
      [w.team],
    );
    expect(addedAudit).toHaveLength(1);
    expect(addedAudit[0]?.target).toMatchObject({ projectId: w.projectId, source: "proposal" });
    expect(JSON.stringify(addedAudit[0]?.target)).not.toContain("spec");
    // A repeat of the applied call answers the file again; no second approval, no second file.
    expect(await propose(sb, w, "f1", input, ref)).toMatchObject({
      ok: true,
      status: "applied",
      path: "docs/spec.md",
    });
    expect(await approvals(w.team)).toHaveLength(1);
    expect(await fileRows(w.team)).toHaveLength(1);
  });

  it("a denied approval adds nothing", async () => {
    const w = await world();
    await inProject(w);
    const sb = await started(w);
    const ref = await pushed(w, "notes/spec.md", "x");
    await check(sb, w, "d1", input);
    expect(await propose(sb, w, "d1", input, ref)).toMatchObject({ status: "pending_approval" });
    const [approval] = await approvals(w.team);
    await decide(w.owner, must(approval, "approval").id, "deny");
    expect(await refusals(w.team)).toContain("approval_denied");
    expect(await fileRows(w.team)).toEqual([]);
    const keys = [...objects.objects.keys()].filter(
      (k) => k.includes(w.team) && k.includes("/projects/"),
    );
    expect(keys).toEqual([]);
  });

  it("is refused without an allowed policy check, or with other input than the allowed one", async () => {
    const w = await world();
    await inProject(w);
    const sb = await started(w);
    const ref = await pushed(w, "notes/spec.md", "x");
    const unchecked = await propose(sb, w, "u1", input, ref);
    expect(errorCode(unchecked)).toBe("not_allowed");
    await check(sb, w, "u2", input);
    const forged = await propose(sb, w, "u2", { ...input, folder: "elsewhere" }, ref);
    expect(errorCode(forged)).toBe("not_allowed");
    expect(await refusals(w.team)).toEqual(["not_allowed", "input_mismatch"]);
    expect(await approvals(w.team)).toEqual([]);
    expect(await fileRows(w.team)).toEqual([]);
  });

  it("is refused without the projects capability", async () => {
    const w = await world();
    await inProject(w);
    const sb = await started(w, []);
    const ref = await pushed(w, "notes/spec.md", "x");
    await check(sb, w, "k1", input);
    expect(errorCode(await propose(sb, w, "k1", input, ref))).toBe("not_allowed");
    expect(await refusals(w.team)).toEqual(["capability_missing"]);
  });

  it("is refused for a thread outside a project and for a user who is not a member", async () => {
    const w = await world();
    const sb = await started(w);
    const ref = await pushed(w, "notes/spec.md", "x");
    await check(sb, w, "n1", input);
    expect(errorCode(await propose(sb, w, "n1", input, ref))).toBe("not_in_project");
    // In a project the owner (a team admin) did not join: admins manage, they are not members.
    await inProject(w, false);
    await check(sb, w, "n2", input);
    expect(errorCode(await propose(sb, w, "n2", input, ref))).toBe("not_allowed");
    expect(await refusals(w.team)).toEqual(["no_project", "not_a_member"]);
    expect(await approvals(w.team)).toEqual([]);
    expect(await fileRows(w.team)).toEqual([]);
  });

  it("is refused when the pushed entry is not what the workspace holds, or names another path", async () => {
    const w = await world();
    await inProject(w);
    const sb = await started(w);
    const ref = await pushed(w, "notes/spec.md", "v1");
    await check(sb, w, "s1", input);
    expect(errorCode(await propose(sb, w, "s1", input, { ...ref, rev: ref.rev + 5 }))).toBe(
      "not_synced",
    );
    await check(sb, w, "s2", input);
    expect(errorCode(await propose(sb, w, "s2", input, { ...ref, path: "other.md" }))).toBe(
      "not_allowed",
    );
    expect(await refusals(w.team)).toEqual(["not_synced", "path_mismatch"]);
    expect(await approvals(w.team)).toEqual([]);
  });

  it.each([
    ["auto approval mode", `UPDATE runs SET approval_mode = 'auto'`],
    ["a scheduled run", `UPDATE runs SET trigger = 'schedule'`],
  ])("%s never waits: the add is refused at once and reported", async (_name, update) => {
    const w = await world();
    await inProject(w);
    await fx.admin.query(`${update} WHERE team_id = $1 AND id = $2`, [w.team, w.runId]);
    const sb = await started(w);
    const ref = await pushed(w, "notes/spec.md", "x");
    await check(sb, w, "a1", input);
    const res = await propose(sb, w, "a1", input, ref);
    expect(errorCode(res)).toBe("not_allowed");
    expect(await approvals(w.team)).toEqual([]);
    expect(await fileRows(w.team)).toEqual([]);
    const denied = await rows<{ payload: { tool: string } }>(
      `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND type = 'policy.denied'`,
      [w.team, w.runId],
    );
    expect(denied[0]?.payload.tool).toBe("propose_project_file");
  });
});
