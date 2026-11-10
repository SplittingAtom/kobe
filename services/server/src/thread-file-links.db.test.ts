import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, withTeam, type KobeDatabase } from "@kobe/db";
import { approvalKeyring } from "./approvals/index.js";
import { createPolicyEngine } from "./policy/engine.js";
import { createDbRuleSource, createDbSettingsSource } from "./policy/rule-store.js";
import { writeCommit, type TreeFile } from "./projects/tree.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { BACKFILL_CURSOR_KEY, backfillThreadFileLinks } from "./thread-file-links/backfill.js";

/**
 * Thread–file links recorded by the server (KOBE-610, spec thread-file-map §3): allowed file tool
 * calls at the policy decision (paths normalised, outside `/workspace` and `bash` ignored, project
 * mounts resolved to the project), project commits from a thread, and the one-time backfill from
 * stored tool calls (idempotent, resumable). Moves and deletes are the triggers' (db package test).
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
const sandboxes: FakeSandbox[] = [];
const extraDbs: KobeDatabase[] = [];
const KEY = approvalKeyring("approval-key-for-tests-".padEnd(48, "k"));
const SHA = "b".repeat(64);

beforeAll(async () => {
  await fx.setup([{}], () => {
    const database = createDb(fx.database.appUrl);
    extraDbs.push(database);
    return {
      approvalKeys: KEY,
      approvals: { pollMs: 100 },
      sandboxWire: {
        sweep: false,
        engine: createPolicyEngine({
          rules: createDbRuleSource(database.db),
          settings: createDbSettingsSource(database.db, 0),
        }),
        tuning: { batchWindowMs: 20, resultPollMs: 200 },
      },
    };
  });
  listeners.push(await sandboxListener(fx.replica(0).deps, auth));
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  for (const l of listeners) await l.close();
  await fx.teardown();
  for (const d of extraDbs) await d.close();
});

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly runId: string;
  readonly threadId: string;
  readonly sb: FakeSandbox;
}

async function world(): Promise<World> {
  const owner = await fx.person(`l${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`tfl-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE id = $1`,
    [runId],
  );
  const threadId = must(rows[0], "run").thread_id;
  const sandboxId = randomUUID();
  const token = auth.issue({ sandboxId, teamId: team, userId: owner.id });
  const sb = await FakeSandbox.connect(must(listeners[0], "listener").url, token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId);
  await sb.ready();
  const started = await fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: team, userId: owner.id },
      { runId, threadId, message: "hello" },
    );
  expect(started).toEqual({ ok: true });
  return { team, owner, runId, threadId, sb };
}

let nextRequest = 0;
async function check(w: World, tool: string, input: Record<string, unknown>) {
  const requestId = `r${(nextRequest += 1)}`;
  w.sb.send({
    v: 1,
    type: "policy.check",
    request_id: requestId,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: `call-${requestId}`,
    tool,
    input,
  });
  return w.sb.until(() => w.sb.frames("policy.result").find((f) => f.request_id === requestId));
}

async function allowRule(w: World, toolGlob: string) {
  const res = await w.owner.browser.post("/v1/team/policy/rules", {
    effect: "allow",
    tool_glob: toolGlob,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
}

type Row = { scope: string; path: string; access: string; count: number; deleted: boolean };
async function linksOf(threadId: string): Promise<Row[]> {
  const { rows } = await fx.admin.query<Row>(
    `SELECT CASE WHEN project_id IS NULL THEN 'owner' ELSE 'project' END AS scope, path, access,
            count, deleted_at IS NOT NULL AS deleted
       FROM thread_file_links WHERE thread_id = $1 ORDER BY scope, path, access`,
    [threadId],
  );
  return rows;
}

async function liveFile(team: string, userId: string, path: string) {
  await fx.admin.query(
    `INSERT INTO workspace_files
       (team_id, user_id, path, rev, deleted, sha256, blob_key, size, mtime_ms, origin)
     VALUES ($1, $2, $3, 1, false, $4, 'k', 1, 0, 'sandbox')`,
    [team, userId, path, SHA],
  );
}

async function project(team: string, owner: Person, slug: string): Promise<string> {
  const { rows } = await fx.admin.query<{ id: string }>(
    `INSERT INTO projects (team_id, slug, name, created_by) VALUES ($1, $2, $2, $3) RETURNING id`,
    [team, slug, owner.id],
  );
  return must(rows[0], "project").id;
}

describe("links from allowed file tool calls (policy decision)", () => {
  it("records reads and writes with normalised paths; ignores bash, outside paths, denials", async () => {
    const w = await world();
    await liveFile(w.team, w.owner.id, "notes/a.md");
    await allowRule(w, "write");
    expect((await check(w, "read", { path: "/workspace/notes/a.md" })).decision).toBe("allow");
    expect((await check(w, "read", { path: "notes/./a.md" })).decision).toBe("allow");
    expect((await check(w, "write", { path: "out/new.md", content: "x" })).decision).toBe("allow");
    expect((await check(w, "ls", { path: "/workspace/notes" })).decision).toBe("allow");
    await check(w, "ls", {});
    await check(w, "read", { path: "/etc/hostname" });
    await check(w, "bash", { command: "cat /workspace/notes/b.md > /workspace/c.md" });
    // A call the policy denies (bad input) links nothing.
    expect((await check(w, "read", { path: "~/x.md" })).decision).toBe("deny");
    expect(await linksOf(w.threadId)).toEqual([
      { scope: "owner", path: "notes", access: "read", count: 1, deleted: false },
      { scope: "owner", path: "notes/a.md", access: "read", count: 2, deleted: false },
      // Not pushed yet: marked deleted until the file arrives (the trigger clears it).
      { scope: "owner", path: "out/new.md", access: "write", count: 1, deleted: true },
    ]);
    await liveFile(w.team, w.owner.id, "out/new.md");
    expect((await linksOf(w.threadId)).find((l) => l.path === "out/new.md")?.deleted).toBe(false);
  });

  it("links a mounted project's file to the project, by its path inside it", async () => {
    const w = await world();
    const projectId = await project(w.team, w.owner, `docs-${randomBytes(2).toString("hex")}`);
    const { rows } = await fx.admin.query<{ slug: string }>(
      `SELECT slug FROM projects WHERE id = $1`,
      [projectId],
    );
    const slug = must(rows[0], "slug").slug;
    await check(w, "read", { path: `/workspace/projects/${slug}/guide/a.md` });
    await check(w, "read", { path: `/workspace/projects/nope/a.md` });
    await check(w, "ls", { path: `/workspace/projects/${slug}` });
    expect(await linksOf(w.threadId)).toEqual([
      { scope: "project", path: "guide/a.md", access: "read", count: 1, deleted: true },
    ]);
  });
});

describe("links from project commits", () => {
  it("records every file a commit from the thread changed as written", async () => {
    const w = await world();
    const projectId = await project(w.team, w.owner, `c-${randomBytes(2).toString("hex")}`);
    const file = (path: string, sha = SHA): TreeFile => ({
      path,
      sha256: sha,
      blobRef: `blob-${path}`,
      size: 1,
      mime: "text/plain",
      executable: false,
    });
    const commit = (tree: TreeFile[], threadId?: string) =>
      withTeam(fx.db, w.team, (tx) =>
        writeCommit(tx, {
          teamId: w.team,
          projectId,
          tree: new Map(tree.map((f) => [f.path, f])),
          author: { userId: w.owner.id, kind: "agent", ...(threadId ? { threadId } : {}) },
          message: "test",
        }),
      );
    await commit([file("a.md"), file("b.md")]);
    await commit([file("a.md", "c".repeat(64)), file("c.md")], w.threadId);
    expect(await linksOf(w.threadId)).toEqual([
      { scope: "project", path: "a.md", access: "write", count: 1, deleted: false },
      { scope: "project", path: "b.md", access: "write", count: 1, deleted: true },
      { scope: "project", path: "c.md", access: "write", count: 1, deleted: false },
    ]);
  });
});

describe("backfill from stored tool calls (TFM3)", () => {
  async function entries(team: string, threadId: string) {
    const msg = (id: string, parent: string | null, message: unknown) =>
      fx.admin.query(
        `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
         VALUES ($1, $2, $3, $4, 'message', $5)`,
        [team, threadId, id, parent, JSON.stringify({ message })],
      );
    await msg("e1", null, {
      role: "assistant",
      content: [
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "/workspace/notes/a.md" } },
        { type: "toolCall", id: "c2", name: "write", arguments: { path: "w.md", content: "" } },
        { type: "toolCall", id: "c3", name: "bash", arguments: { command: "cat x.md" } },
      ],
    });
    await msg("e2", "e1", {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      isError: false,
    });
    await msg("e3", "e2", {
      role: "toolResult",
      toolCallId: "c2",
      toolName: "write",
      isError: true,
    });
    await msg("e4", "e3", {
      role: "toolResult",
      toolCallId: "c3",
      toolName: "bash",
      isError: false,
    });
    await msg("e5", "e4", {
      role: "assistant",
      content: [{ type: "toolCall", id: "c4", name: "read", arguments: { path: "notes/a.md" } }],
    });
    await msg("e6", "e5", {
      role: "toolResult",
      toolCallId: "c4",
      toolName: "read",
      isError: false,
    });
  }

  it("is idempotent and resumable, with the cursor in site_settings", async () => {
    const w = await world();
    await liveFile(w.team, w.owner.id, "notes/a.md");
    await entries(w.team, w.threadId);
    // A second thread of the same team, also with stored calls.
    const second = await fx.run(w.team, w.owner);
    const { rows } = await fx.admin.query<{ thread_id: string }>(
      `SELECT thread_id FROM runs WHERE id = $1`,
      [second],
    );
    const secondThread = must(rows[0], "run").thread_id;
    await entries(w.team, secondThread);

    const db = fx.db;
    const first = await backfillThreadFileLinks(db, { restart: true, maxThreads: 1 });
    expect(first).toMatchObject({ threads: 1, done: false });
    const rest = await backfillThreadFileLinks(db);
    expect(rest.done).toBe(true);
    const expected = [
      { scope: "owner", path: "notes/a.md", access: "read", count: 2, deleted: false },
    ];
    expect(await linksOf(w.threadId)).toEqual(expected);
    expect(await linksOf(secondThread)).toEqual(expected);
    const cursor = await fx.admin.query<{ value: string }>(
      `SELECT value FROM site_settings WHERE key = $1`,
      [BACKFILL_CURSOR_KEY],
    );
    expect(cursor.rows[0]?.value).toBe("done");
    // Done: a plain run does nothing; a restart walks again and changes nothing (idempotent).
    expect(await backfillThreadFileLinks(db)).toEqual({ threads: 0, links: 0, done: true });
    const again = await backfillThreadFileLinks(db, { restart: true });
    expect(again.done).toBe(true);
    expect(await linksOf(w.threadId)).toEqual(expected);
    expect(await linksOf(secondThread)).toEqual(expected);
  });
});
