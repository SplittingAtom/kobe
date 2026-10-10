import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITY_FILES, sharedFileSchema, type PolicyEngine } from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { blobRecorder } from "./retention/job.js";
import { deleteReleasedBlobs, purgeThreads } from "./retention/index.js";
import { createWorkspaceSync, workspaceBlobKey } from "./workspace-sync/index.js";

/**
 * KOBE-150 end to end: `file.share` accepted only for a connection that announced `files`, an
 * active leased run, an allowed `share_file` call with the same input hash, and a workspace
 * manifest row that still matches the push (rev, sha256, size); the bytes are copied into the
 * thread's key tree, the `files` row is idempotent on the tool call, `file.shared` is emitted,
 * refusals are audited, and /v1/files serves the file to thread readers only.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const objects = new MemoryObjects();
const PREFIX = "kobe/";
const blobs = { objects, prefix: PREFIX };
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 1024 * 1024, maxWorkspaceBytes: 4 * 1024 * 1024, maxFiles: 50 };
const MAX_FILE = 4096;
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;
let sync: ReturnType<typeof createWorkspaceSync>;

const allowAll: PolicyEngine = {
  decide: () =>
    Promise.resolve({
      effect: "allow" as const,
      risk: "write" as const,
      reasons: [{ code: "team_allow_rule" as const, stage: "user_allow" as const, message: "ok" }],
    }),
};

beforeAll(async () => {
  await fx.setup([{}], () => ({
    blobs,
    uploads: {
      maxFileBytes: MAX_FILE,
      maxMessageBytes: MAX_FILE,
      defaultQuotaBytes: 1_000_000,
      orphanHours: 24,
    },
    sandboxWire: {
      engine: allowAll,
      sweep: false,
      tuning: { batchWindowMs: 20, resultPollMs: 200, lostGraceMs: 0, helloTimeoutMs: 1_000 },
    },
  }));
  sync = createWorkspaceSync({ db: fx.db, objects, prefix: PREFIX, limits: LIMITS, log: silent });
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
  const owner = await fx.person(`u${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`f-${randomBytes(3).toString("hex")}`, owner);
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

async function started(w: World, capabilities: readonly string[] = [CAPABILITY_FILES]) {
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

interface Pushed {
  readonly path: string;
  readonly rev: number;
  readonly sha256: string;
  readonly size: number;
}

/** A file the sandbox "pushed": a manifest row and its workspace blob. */
async function push(w: World, path: string, content: string | Buffer): Promise<Pushed> {
  const data = Buffer.from(content);
  const owner = { teamId: w.team, userId: w.owner.id };
  const sha256 = createHash("sha256").update(data).digest("hex");
  const key = workspaceBlobKey(PREFIX, owner, sha256);
  objects.objects.set(key, data);
  await withTeam(fx.db, w.team, (tx) =>
    sync.putServerFile(tx, owner, { path, sha256, size: data.length, blobKey: key }, "user"),
  );
  const { rows } = await fx.admin.query<{ rev: string }>(
    `SELECT rev FROM workspace_files WHERE team_id = $1 AND user_id = $2 AND path = $3`,
    [w.team, w.owner.id, path],
  );
  return { path, rev: Number(must(rows[0], "row").rev), sha256, size: data.length };
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
    tool: "share_file",
    input,
  });
  return sb.until(() => sb.frames("policy.result").find((r) => r.request_id === request_id), 3000);
}

async function share(
  sb: FakeSandbox,
  w: World,
  callId: string,
  input: Input,
  workspace: Pushed | Record<string, unknown>,
) {
  const request_id = `s${seq++}`;
  sb.send({
    v: 1,
    type: "file.share",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool: "share_file",
    input,
    workspace,
  });
  return sb.until(
    () => sb.frames("file.share_result").find((r) => r.request_id === request_id),
    3000,
  );
}

async function allowedShare(
  sb: FakeSandbox,
  w: World,
  callId: string,
  input: Input,
  workspace: Pushed | Record<string, unknown>,
) {
  expect((await check(sb, w, callId, input)).decision).toBe("allow");
  return share(sb, w, callId, input, workspace);
}

const rows = async <T>(text: string, params: unknown[]) =>
  (await fx.admin.query(text, params)).rows as T[];
const fileCount = async (team: string) =>
  Number(
    (await rows<{ n: string }>(`SELECT count(*) AS n FROM files WHERE team_id = $1`, [team]))[0]?.n,
  );

async function refusals(team: string): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 300)); // audit rows are written off the frame path
  return (
    await rows<{ target: { reason: string } }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'sandbox.file_share_refused' ORDER BY seq`,
      [team],
    )
  ).map((r) => r.target.reason);
}

const errorCode = (r: unknown) => (r as { ok: boolean; error?: { code: string } }).error?.code;

describe("file.share: store", () => {
  it("copies the workspace object into the thread tree, adds the row, audits and emits file.shared", async () => {
    const w = await world();
    const sb = await started(w);
    const pushed = await push(w, "out/report.txt", "quarterly numbers");
    const input = { path: "/workspace/out/report.txt", description: "The report" };
    const res = await allowedShare(sb, w, "call-1", input, pushed);

    expect(res.ok).toBe(true);
    const ok = sharedFileSchema.parse(
      Object.fromEntries(
        Object.entries(res).filter(([k]) => !["v", "type", "request_id", "ok"].includes(k)),
      ),
    );
    expect(ok).toMatchObject({
      name: "report.txt",
      size_bytes: pushed.size,
      sha256: pushed.sha256,
      scan: "skipped",
    });

    const [row] = await rows<{
      kind: string;
      blob_ref: string;
      thread_id: string;
      run_id: string;
      tool_call_id: string;
      user_id: string;
    }>(
      `SELECT kind, blob_ref, thread_id, run_id, tool_call_id, user_id FROM files WHERE team_id = $1 AND id = $2`,
      [w.team, ok.file_id],
    );
    expect(row).toMatchObject({
      kind: "shared",
      thread_id: w.threadId,
      run_id: w.runId,
      tool_call_id: "call-1",
      user_id: w.owner.id,
    });
    expect(row?.blob_ref).toBe(
      `${PREFIX}teams/${w.team}/threads/${w.threadId}/shared/${ok.file_id}`,
    );
    expect(objects.objects.get(must(row, "row").blob_ref)?.toString()).toBe("quarterly numbers");

    const events = await rows<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND type = 'file.shared'`,
      [w.team, w.runId],
    );
    expect(events.map((e) => e.payload)).toEqual([
      {
        file_id: ok.file_id,
        tool_call_id: "call-1",
        name: "report.txt",
        size: pushed.size,
        mime_type: "application/octet-stream",
        description: "The report",
      },
    ]);
    const audit = await rows<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'workspace.file_shared'`,
      [w.team],
    );
    expect(audit.map((a) => a.target)).toEqual([
      { userId: w.owner.id, sharedId: ok.file_id, bytes: pushed.size },
    ]);
    // The queued cleanup entry is cleared with the commit.
    expect(
      await rows(`SELECT 1 FROM retention_blob_deletions WHERE team_id = $1`, [w.team]),
    ).toEqual([]);
  });

  it("uses the given name and answers a repeated call with the first result, once", async () => {
    const w = await world();
    const sb = await started(w);
    const pushed = await push(w, "a.bin", "bytes");
    const input = { path: "a.bin", name: "Nice name.bin" };
    const first = await allowedShare(sb, w, "call-1", input, pushed);
    const again = await share(sb, w, "call-1", input, pushed);
    expect(again.ok).toBe(true);
    expect((again as { file_id: string }).file_id).toBe((first as { file_id: string }).file_id);
    expect((again as { name: string }).name).toBe("Nice name.bin");
    expect(await fileCount(w.team)).toBe(1);
    const n = await rows<{ n: string }>(
      `SELECT count(*) AS n FROM run_events WHERE team_id = $1 AND type = 'file.shared'`,
      [w.team],
    );
    expect(Number(n[0]?.n)).toBe(1);
    expect(objects.keys(`${PREFIX}teams/${w.team}/threads/`)).toHaveLength(1);
  });

  it("survives losing the workspace: the download needs only the shared copy", async () => {
    const w = await world();
    const sb = await started(w);
    const pushed = await push(w, "gone.txt", "still here");
    const res = await allowedShare(sb, w, "call-1", { path: "gone.txt" }, pushed);
    const id = (res as { file_id: string }).file_id;
    // The volume and the workspace copy are gone.
    await fx.admin.query(`DELETE FROM workspace_files WHERE team_id = $1`, [w.team]);
    objects.objects.delete(
      workspaceBlobKey(PREFIX, { teamId: w.team, userId: w.owner.id }, pushed.sha256),
    );

    const dl = await w.owner.browser.get(`/v1/files/${id}/content`);
    expect(dl.status).toBe(200);
    expect(dl.text).toBe("still here");
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment; filename="gone\.txt"/);
    const meta = await w.owner.browser.get(`/v1/files/${id}`);
    expect(meta.status).toBe(200);
    expect(meta.json).toMatchObject({ file_id: id, name: "gone.txt", thread_id: w.threadId });
  });
});

describe("file.share: refusals", () => {
  it("refuses a connection without the files capability, and audits it", async () => {
    const w = await world();
    const sb = await started(w, []);
    const pushed = await push(w, "x.txt", "x");
    const res = await allowedShare(sb, w, "call-1", { path: "x.txt" }, pushed);
    expect(errorCode(res)).toBe("not_allowed");
    expect(await fileCount(w.team)).toBe(0);
    expect(await refusals(w.team)).toEqual(["capability_missing"]);
  });

  it("refuses a call policy did not allow, or allowed with other input", async () => {
    const w = await world();
    const sb = await started(w);
    const pushed = await push(w, "x.txt", "x");
    expect(errorCode(await share(sb, w, "never-checked", { path: "x.txt" }, pushed))).toBe(
      "not_allowed",
    );
    expect((await check(sb, w, "call-2", { path: "x.txt" })).decision).toBe("allow");
    const forged = await share(sb, w, "call-2", { path: "x.txt", name: "other.txt" }, pushed);
    expect(errorCode(forged)).toBe("not_allowed");
    expect(await fileCount(w.team)).toBe(0);
    expect(await refusals(w.team)).toEqual(["not_allowed", "input_mismatch"]);
  });

  it("refuses a push the manifest does not match: wrong rev, hash or size, unknown path", async () => {
    const w = await world();
    const sb = await started(w);
    const pushed = await push(w, "m.txt", "content");
    const input = { path: "m.txt" };
    expect((await check(sb, w, "call-1", input)).decision).toBe("allow");
    for (const bad of [
      { ...pushed, rev: pushed.rev + 1 },
      { ...pushed, sha256: "0".repeat(64) },
      { ...pushed, size: pushed.size + 1 },
    ]) {
      expect(errorCode(await share(sb, w, "call-1", input, bad))).toBe("not_synced");
    }
    // The file changed after the push (a newer rev): the old claim no longer holds.
    await push(w, "m.txt", "content v2");
    expect(errorCode(await share(sb, w, "call-1", input, pushed))).toBe("not_synced");
    // A path that was never pushed.
    const ghost = { ...pushed, path: "ghost.txt" };
    expect((await check(sb, w, "call-2", { path: "ghost.txt" })).decision).toBe("allow");
    expect(errorCode(await share(sb, w, "call-2", { path: "ghost.txt" }, ghost))).toBe("not_found");
    // The input names one file and the push another.
    expect((await check(sb, w, "call-3", { path: "m.txt" })).decision).toBe("allow");
    expect(errorCode(await share(sb, w, "call-3", { path: "m.txt" }, ghost))).toBe("not_allowed");
    expect(await fileCount(w.team)).toBe(0);
    expect(objects.keys(`${PREFIX}teams/${w.team}/threads/`)).toEqual([]);
    expect(await refusals(w.team)).toEqual(["not_synced", "not_found", "path_mismatch"]);
  });

  it("refuses a file over the size limit before copying", async () => {
    const w = await world();
    const sb = await started(w);
    const pushed = await push(w, "big.bin", Buffer.alloc(MAX_FILE + 1, 1));
    const res = await allowedShare(sb, w, "call-1", { path: "big.bin" }, pushed);
    expect(errorCode(res)).toBe("too_large");
    expect(await fileCount(w.team)).toBe(0);
    expect(objects.keys(`${PREFIX}teams/${w.team}/threads/`)).toEqual([]);
    expect(await refusals(w.team)).toEqual(["too_large"]);
  });

  it("refuses over the team quota: no row, no object left", async () => {
    const w = await world();
    const sb = await started(w);
    await fx.admin.query(
      `INSERT INTO team_storage_quotas (team_id, max_bytes, updated_by) VALUES ($1, $2, $3)`,
      [w.team, 100, w.owner.id],
    );
    const pushed = await push(w, "q.bin", Buffer.alloc(200, 2));
    const res = await allowedShare(sb, w, "call-1", { path: "q.bin" }, pushed);
    expect(errorCode(res)).toBe("quota_exceeded");
    expect(await fileCount(w.team)).toBe(0);
    expect(objects.keys(`${PREFIX}teams/${w.team}/threads/`)).toEqual([]);
    expect(await refusals(w.team)).toEqual(["quota_exceeded"]);
  });

  it("refuses a tool call id another run already used", async () => {
    const w = await world();
    const sb = await started(w);
    const pushed = await push(w, "r.txt", "r");
    const ok = await allowedShare(sb, w, "call-1", { path: "r.txt" }, pushed);
    expect(ok.ok).toBe(true);
    const otherRun = await fx.run(w.team, w.owner);
    await fx.admin.query(`UPDATE files SET run_id = $2 WHERE team_id = $1`, [w.team, otherRun]);
    expect(errorCode(await share(sb, w, "call-1", { path: "r.txt" }, pushed))).toBe("not_allowed");
    expect(await fileCount(w.team)).toBe(1);
  });

  it("stores nothing when the run ended after the policy check", async () => {
    const w = await world();
    const sb = await started(w);
    const pushed = await push(w, "late.txt", "late");
    expect((await check(sb, w, "call-1", { path: "late.txt" })).decision).toBe("allow");
    await fx.complete(w.team, w.runId);
    expect(errorCode(await share(sb, w, "call-1", { path: "late.txt" }, pushed))).toBe(
      "not_allowed",
    );
    expect(await fileCount(w.team)).toBe(0);
    expect(objects.keys(`${PREFIX}teams/${w.team}/threads/`)).toEqual([]);
    expect(await refusals(w.team)).toEqual(["run_not_active"]);
  });
});

describe("GET /v1/files", () => {
  async function shared(w: World, sb: FakeSandbox): Promise<string> {
    const pushed = await push(w, "s.txt", "secret-content");
    const res = await allowedShare(sb, w, "call-1", { path: "s.txt" }, pushed);
    return (res as { file_id: string }).file_id;
  }

  it("serves thread readers only: others in the team, other teams, uploads and unknown ids are 404", async () => {
    const w = await world();
    const sb = await started(w);
    const id = await shared(w, sb);
    const colleague = await fx.person("colleague");
    await fx.addMember(w.team, colleague);
    await fx.activate(colleague, w.team);
    const intruder = await fx.person("intruder");
    await fx.team(`x-${randomBytes(3).toString("hex")}`, intruder);

    expect((await w.owner.browser.get(`/v1/files/${id}/content`)).status).toBe(200);
    for (const p of [colleague, intruder]) {
      expect((await p.browser.get(`/v1/files/${id}`)).status).toBe(404);
      expect((await p.browser.get(`/v1/files/${id}/content`)).status).toBe(404);
    }
    expect((await w.owner.browser.get(`/v1/files/${randomUUID()}/content`)).status).toBe(404);
    expect((await w.owner.browser.get("/v1/files/not-a-uuid")).status).toBe(400);
    // An upload row is private to its uploader and not served here.
    await fx.admin.query(
      `INSERT INTO files (team_id, id, user_id, thread_id, kind, name, size_bytes, sha256, mime_type, blob_ref)
       VALUES ($1, $2, $3, $4, 'upload', 'u.txt', 1, $5, 'text/plain', 'k')`,
      [w.team, "00000000-0000-4000-8000-00000000000a", w.owner.id, w.threadId, "a".repeat(64)],
    );
    expect(
      (await w.owner.browser.get("/v1/files/00000000-0000-4000-8000-00000000000a")).status,
    ).toBe(404);
  });

  it("never serves a rejected file, and says unavailable when the object is missing", async () => {
    const w = await world();
    const sb = await started(w);
    const id = await shared(w, sb);
    const [row] = await rows<{ blob_ref: string }>(`SELECT blob_ref FROM files WHERE id = $1`, [
      id,
    ]);
    objects.lost.add(must(row, "row").blob_ref);
    expect((await w.owner.browser.get(`/v1/files/${id}/content`)).status).toBe(503);
    await fx.admin.query(`UPDATE files SET scan_status = 'rejected' WHERE id = $1`, [id]);
    expect((await w.owner.browser.get(`/v1/files/${id}/content`)).status).toBe(404);
  });
});

describe("retention", () => {
  it("purges the shared copy with its thread", async () => {
    const w = await world();
    const sb = await started(w);
    const pushed = await push(w, "p.txt", "purge me");
    await allowedShare(sb, w, "call-1", { path: "p.txt" }, pushed);
    expect(objects.keys(`${PREFIX}teams/${w.team}/threads/${w.threadId}/shared/`)).toHaveLength(1);
    await fx.complete(w.team, w.runId);
    const outcome = await purgeThreads(
      fx.db,
      w.team,
      { kind: "user", userId: w.owner.id },
      async () => {},
    );
    expect(outcome).toMatchObject({ status: "done" });
    expect(await fileCount(w.team)).toBe(0);
    await deleteReleasedBlobs(fx.db, w.team, blobs, blobRecorder(w.team), { maxBatches: 5 });
    expect(objects.keys(`${PREFIX}teams/${w.team}/threads/`)).toEqual([]);
  });
});
