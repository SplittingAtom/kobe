import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITY_SKILL_DRAFTS, type PolicyEngine } from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { createWorkspaceSync, workspaceBlobKey } from "./workspace-sync/index.js";

/**
 * KOBE-442 end to end: `skill.draft_save` accepted only for a connection that announced
 * `skill_drafts`, an active leased run, an allowed `save_skill_draft` call with the same input
 * hash, and files that are each under the folder with a live manifest row exactly as pushed. The
 * result is the member's private draft started from this thread (a second save updates it), never
 * a version, a submission or an eval; refusals are audited.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const objects = new MemoryObjects();
const PREFIX = "kobe/";
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 1024 * 1024, maxWorkspaceBytes: 4 * 1024 * 1024, maxFiles: 50 };
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
    blobs: { objects, prefix: PREFIX },
    sandboxWire: {
      engine: allowAll,
      sweep: false,
      tuning: { batchWindowMs: 20, resultPollMs: 200, lostGraceMs: 0, helloTimeoutMs: 1_000 },
    },
  }));
  sync = createWorkspaceSync({ db: fx.db, objects, prefix: PREFIX, limits: LIMITS, log: silent });
  fx.replica(0).deps.skillDraftTool.use(sync);
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
  const team = await fx.team(`sd-${randomBytes(3).toString("hex")}`, owner);
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

async function started(w: World, capabilities: readonly string[] = [CAPABILITY_SKILL_DRAFTS]) {
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

/** A file the sandbox "pushed" into (team, user)'s workspace: a manifest row and its blob. */
async function push(team: string, userId: string, path: string, content: string): Promise<Pushed> {
  const data = Buffer.from(content);
  const owner = { teamId: team, userId };
  const sha256 = createHash("sha256").update(data).digest("hex");
  const key = workspaceBlobKey(PREFIX, owner, sha256);
  objects.objects.set(key, data);
  await withTeam(fx.db, team, (tx) =>
    sync.putServerFile(tx, owner, { path, sha256, size: data.length, blobKey: key }, "user"),
  );
  const { rows } = await fx.admin.query<{ rev: string }>(
    `SELECT rev FROM workspace_files WHERE team_id = $1 AND user_id = $2 AND path = $3`,
    [team, userId, path],
  );
  return { path, rev: Number(must(rows[0], "row").rev), sha256, size: data.length };
}

const skillMd = (name: string, body = "Be brief.") =>
  `---\nname: ${name}\ndescription: Does ${name} things. Use when asked about ${name}.\n---\n# ${name}\n${body}\n`;

let seq = 0;

async function check(sb: FakeSandbox, w: World, callId: string, input: Record<string, unknown>) {
  const request_id = `c${seq++}`;
  sb.send({
    v: 1,
    type: "policy.check",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool: "save_skill_draft",
    input,
  });
  return sb.until(() => sb.frames("policy.result").find((r) => r.request_id === request_id), 3000);
}

async function save(
  sb: FakeSandbox,
  w: World,
  callId: string,
  folder: string,
  files: readonly Pushed[],
) {
  const request_id = `s${seq++}`;
  sb.send({
    v: 1,
    type: "skill.draft_save",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool: "save_skill_draft",
    input: { folder },
    files,
  });
  return sb.until(
    () => sb.frames("skill.draft_save_result").find((r) => r.request_id === request_id),
    5000,
  );
}

async function allowedSave(
  sb: FakeSandbox,
  w: World,
  callId: string,
  folder: string,
  files: readonly Pushed[],
) {
  expect((await check(sb, w, callId, { folder })).decision).toBe("allow");
  return save(sb, w, callId, folder, files);
}

const rows = async <T>(text: string, params: unknown[]) =>
  (await fx.admin.query(text, params)).rows as T[];

async function refusals(team: string): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 300)); // audit rows are written off the frame path
  return (
    await rows<{ target: { reason: string } }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'sandbox.skill_draft_refused' ORDER BY seq`,
      [team],
    )
  ).map((r) => r.target.reason);
}

const errorCode = (r: unknown) => (r as { error?: { code: string } }).error?.code;

describe("save_skill_draft: a private Workbench draft from the conversation (ac-1, ac-2)", () => {
  it("creates the draft from the pushed files, then updates it on a second save", async () => {
    const w = await world();
    const sb = await started(w);
    const md = await push(
      w.team,
      w.owner.id,
      "skills/close-helper/SKILL.md",
      skillMd("close-helper"),
    );
    const ref = await push(w.team, w.owner.id, "skills/close-helper/references/a.md", "Steps.");
    const cases = await push(
      w.team,
      w.owner.id,
      "skills/close-helper/evals/cases.yaml",
      "cases:\n  - id: one\n    prompt: Close March\n    expect: { triggers: true }\n",
    );
    // A live file the sandbox did not name is not part of the save.
    await push(w.team, w.owner.id, "skills/close-helper/stray.md", "Deleted in the sandbox.");

    const first = await allowedSave(sb, w, "call-1", "close-helper", [md, ref, cases]);
    expect(first, JSON.stringify(first)).toMatchObject({
      ok: true,
      op: "skill_draft_save",
      name: "close-helper",
      created: true,
      file_count: 3,
    });
    const draftId = (first as { draft_id: string }).draft_id;
    const [draft] = await rows<{
      owner_user_id: string;
      shared: boolean;
      started_from: string;
      from_thread_id: string;
    }>(
      `SELECT owner_user_id, shared, started_from, from_thread_id FROM skill_drafts WHERE team_id = $1 AND id = $2`,
      [w.team, draftId],
    );
    expect(draft).toEqual({
      owner_user_id: w.owner.id,
      shared: false,
      started_from: "thread",
      from_thread_id: w.threadId,
    });
    const files = await w.owner.browser.get(`/v1/skills/drafts/${draftId}`);
    expect(files.status, JSON.stringify(files.json)).toBe(200);
    expect((files.json.files as { path: string }[]).map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "evals/cases.yaml",
      "references/a.md",
    ]);

    // Second save from the same conversation: same draft, new revision, files replaced.
    const md2 = await push(
      w.team,
      w.owner.id,
      "skills/close-helper/SKILL.md",
      skillMd("close-helper", "Be thorough."),
    );
    const again = await allowedSave(sb, w, "call-2", "close-helper", [md2, cases]);
    expect(again).toMatchObject({ ok: true, draft_id: draftId, created: false, file_count: 2 });
    expect((again as { rev: number }).rev).toBeGreaterThan((first as { rev: number }).rev);
    const skill = await w.owner.browser.get(`/v1/skills/drafts/${draftId}/files/SKILL.md`);
    expect(skill.text).toContain("Be thorough.");

    const audit = await rows<{ action: string; actor_id: string; target: Record<string, unknown> }>(
      `SELECT action, actor_id, target FROM audit_log
        WHERE team_id = $1 AND action IN ('skill.draft.created', 'skill.draft.updated') ORDER BY seq`,
      [w.team],
    );
    expect(audit.map((a) => [a.action, a.actor_id, a.target.via, a.target.fromThreadId])).toEqual([
      ["skill.draft.created", w.owner.id, "tool", w.threadId],
      ["skill.draft.updated", w.owner.id, "tool", w.threadId],
    ]);
    // A private draft only: no version, no review submission, no eval.
    for (const table of ["team_skill_versions", "team_skill_reviews", "skill_eval_runs"]) {
      const n = await rows<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE team_id = $1`, [
        w.team,
      ]);
      expect(Number(n[0]?.n), table).toBe(0);
    }
  });

  it("refuses a file not as pushed, outside the folder, or a folder that isn't a skill", async () => {
    const w = await world();
    const sb = await started(w);
    const md = await push(w.team, w.owner.id, "skills/x-one/SKILL.md", skillMd("x-one"));
    // Changed since the push: the live row has a newer rev.
    await push(w.team, w.owner.id, "skills/x-one/SKILL.md", skillMd("x-one", "Newer."));
    expect(errorCode(await allowedSave(sb, w, "c-stale", "x-one", [md]))).toBe("not_synced");
    // Never pushed.
    const ghost = { path: "skills/x-one/ghost.md", rev: 1, sha256: "a".repeat(64), size: 3 };
    expect(errorCode(await allowedSave(sb, w, "c-ghost", "x-one", [ghost]))).toBe("not_synced");
    // A file of another folder.
    const other = await push(w.team, w.owner.id, "notes/secret.md", "Not a skill.");
    expect(errorCode(await allowedSave(sb, w, "c-out", "x-one", [other]))).toBe("not_allowed");
    // Not a skill: no frontmatter.
    const bad = await push(w.team, w.owner.id, "skills/bad/SKILL.md", "Just text.");
    expect(errorCode(await allowedSave(sb, w, "c-bad", "bad", [bad]))).toBe("invalid_skill");
    expect(await refusals(w.team)).toEqual(["not_synced", "path_mismatch", "invalid_skill"]);
    const n = await rows<{ n: string }>(
      `SELECT count(*) AS n FROM skill_drafts WHERE team_id = $1`,
      [w.team],
    );
    expect(Number(n[0]?.n)).toBe(0);
  });
});

describe("save_skill_draft: decided by the server (ac-3, ac-5)", () => {
  it("refuses without the capability, without an allowed call, with other input, after the run", async () => {
    const w = await world();
    const md = await push(w.team, w.owner.id, "skills/y-one/SKILL.md", skillMd("y-one"));
    const plain = await started(w, []);
    expect(errorCode(await allowedSave(plain, w, "c-cap", "y-one", [md]))).toBe("not_allowed");
    plain.close();

    const w2 = await world();
    const md2 = await push(w2.team, w2.owner.id, "skills/y-one/SKILL.md", skillMd("y-one"));
    const sb = await started(w2);
    // No policy check allowed this call (a policy deny leaves none either).
    expect(errorCode(await save(sb, w2, "c-none", "y-one", [md2]))).toBe("not_allowed");
    // Allowed for another folder.
    expect((await check(sb, w2, "c-other", { folder: "z-one" })).decision).toBe("allow");
    expect(errorCode(await save(sb, w2, "c-other", "y-one", [md2]))).toBe("not_allowed");
    // The run ended.
    expect((await check(sb, w2, "c-late", { folder: "y-one" })).decision).toBe("allow");
    await fx.admin.query(`UPDATE runs SET status = 'completed', ended_at = now() WHERE id = $1`, [
      w2.runId,
    ]);
    expect(errorCode(await save(sb, w2, "c-late", "y-one", [md2]))).toBe("not_allowed");

    expect(await refusals(w.team)).toEqual(["capability_missing"]);
    expect(await refusals(w2.team)).toEqual(["not_allowed", "input_mismatch", "run_not_active"]);
  });

  it("reads only the caller's own workspace in the caller's team (cross-team)", async () => {
    const w = await world();
    const sb = await started(w);
    // The same path pushed by another member in another team: not this workspace's row.
    const stranger = await world();
    const theirs = await push(
      stranger.team,
      stranger.owner.id,
      "skills/theirs/SKILL.md",
      skillMd("theirs"),
    );
    expect(errorCode(await allowedSave(sb, w, "c-x", "theirs", [theirs]))).toBe("not_synced");
    const n = await rows<{ n: string }>(
      `SELECT count(*) AS n FROM skill_drafts WHERE team_id IN ($1, $2)`,
      [w.team, stranger.team],
    );
    expect(Number(n[0]?.n)).toBe(0);
  });
});
