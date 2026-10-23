import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { threadFilesResponseSchema } from "@kobe/protocol";
import { runEvents, runs, threadEntries, withTeam } from "@kobe/db";
import { readAgentFiles } from "./threads/agent-files.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { createWorkspaceSync, workspaceBlobKey } from "./workspace-sync/index.js";

/**
 * KOBE-488 (ac-1): `GET /v1/threads/{id}/files` lists the workspace files the agent wrote in the
 * thread (write/edit with a successful result, from run events or, once compacted, the mirrored
 * entries; accepted proposals), normalised, de-duplicated, in first-appearance order, and only
 * files still live in the owner's synced workspace. The owner only: a shared reader and another
 * team get 404.
 */
const fx = new EventStreamFixture();
const objects = new MemoryObjects();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 1024 * 1024, maxWorkspaceBytes: 4 * 1024 * 1024, maxFiles: 50 };
let sync: ReturnType<typeof createWorkspaceSync>;

beforeAll(async () => {
  await fx.setup([{}]);
  sync = createWorkspaceSync({ db: fx.db, objects, prefix: "", limits: LIMITS, log: silent });
});

afterAll(async () => {
  await fx.teardown();
});

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly reader: Person;
  readonly runId: string;
  readonly threadId: string;
}

async function world(): Promise<World> {
  const owner = await fx.person(`o${randomBytes(2).toString("hex")}`);
  const reader = await fx.person(`r${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`tf-${randomBytes(3).toString("hex")}`, owner, [reader]);
  const runId = await fx.run(team, owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  return { team, owner, reader, runId, threadId: must(rows[0], "run").thread_id };
}

const sha = (content: string) => createHash("sha256").update(content).digest("hex");

async function seed(w: World, path: string, content: string) {
  const data = Buffer.from(content);
  const owner = { teamId: w.team, userId: w.owner.id };
  const key = workspaceBlobKey("", owner, sha(content));
  objects.objects.set(key, data);
  await withTeam(fx.db, w.team, (tx) =>
    sync.putServerFile(
      tx,
      owner,
      { path, sha256: sha(content), size: data.length, blobKey: key },
      "user",
    ),
  );
}

async function remove(w: World, path: string) {
  await withTeam(fx.db, w.team, (tx) =>
    sync.deleteServerFile(tx, { teamId: w.team, userId: w.owner.id }, path),
  );
}

let clock = Date.parse("2026-10-01T00:00:00Z");
const tick = () => new Date((clock += 1000));

async function events(
  w: World,
  rows: readonly { type: string; payload: Record<string, unknown> }[],
  runId = w.runId,
) {
  await withTeam(fx.db, w.team, (tx) =>
    tx
      .insert(runEvents)
      .values(rows.map((r) => ({ teamId: w.team, runId, ...r, createdAt: tick() }))),
  );
}

/** Another run of the world's thread. */
async function secondRun(w: World): Promise<string> {
  return withTeam(fx.db, w.team, async (tx) => {
    const [run] = await tx
      .insert(runs)
      .values({
        teamId: w.team,
        threadId: w.threadId,
        trigger: "user",
        status: "completed",
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .returning({ id: runs.id });
    return must(run, "run").id;
  });
}

/** Mirrored message entries of the world's thread, one after another (seq order). */
async function entries(w: World, messages: readonly Record<string, unknown>[]) {
  const at = tick();
  await withTeam(fx.db, w.team, async (tx) => {
    let parentId: string | null = null;
    for (const [i, message] of messages.entries()) {
      const entryId = `m${i}-${randomBytes(2).toString("hex")}`;
      await tx.insert(threadEntries).values({
        teamId: w.team,
        threadId: w.threadId,
        entryId,
        parentId,
        type: "message",
        payload: { type: "message", id: entryId, parentId, message },
        createdAt: at,
      });
      parentId = entryId;
    }
  });
}

const callMsg = (id: string, path: string) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "write", arguments: { path } }],
});
const resultMsg = (id: string, isError = false) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "write",
  isError,
  content: [],
});

/** A tool call and its result as the run's events. */
function written(id: string, tool: string, path: string, isError = false) {
  return [
    {
      type: "tool.call",
      payload: { tool_call_id: id, tool, input: { path, content: "x" }, risk: "write" },
    },
    {
      type: "tool.result",
      payload: { tool_call_id: id, tool, is_error: isError, preview: "", truncated: false },
    },
  ];
}

const proposal = (id: string, path: string, content: string) => ({
  type: "file.edit_proposed",
  payload: { tool_call_id: id, path, base_sha256: sha("old"), content, summary: "s" },
});

async function list(p: Person, threadId: string) {
  return p.browser.get(`/v1/threads/${threadId}/files`);
}

async function paths(w: World): Promise<string[]> {
  const res = await list(w.owner, w.threadId);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return threadFilesResponseSchema.parse(res.json).files.map((f) => f.path);
}

describe("GET /v1/threads/{id}/files", () => {
  it("lists successful writes and edits, normalised, de-duplicated, first appearance first", async () => {
    const w = await world();
    for (const p of ["b.md", "a.html", "notes/c.md", "failed.md", "bash.md"]) await seed(w, p, p);
    await events(w, [
      ...written("1", "write", "/workspace/b.md"),
      ...written("2", "write", "a.html"),
      ...written("3", "edit", "/workspace/b.md"),
      ...written("4", "edit", "notes/c.md"),
      ...written("5", "write", "failed.md", true),
      ...written("6", "bash", "bash.md"),
      ...written("7", "write", "/etc/passwd"),
      {
        type: "tool.call",
        payload: { tool_call_id: "8", tool: "write", input: {}, risk: "write" },
      },
    ]);
    expect(await paths(w)).toEqual(["b.md", "a.html", "notes/c.md"]);
    const res = await list(w.owner, w.threadId);
    const first = threadFilesResponseSchema.parse(res.json).files[0];
    expect(first).toMatchObject({ name: "b.md", type: "file", area: "workspace", size_bytes: 4 });
  });

  it("drops a file that is gone from the workspace and one never synced", async () => {
    const w = await world();
    await seed(w, "keep.md", "k");
    await seed(w, "gone.md", "g");
    await events(w, [
      ...written("1", "write", "keep.md"),
      ...written("2", "write", "gone.md"),
      ...written("3", "write", "never.md"),
    ]);
    expect(await paths(w)).toEqual(["keep.md", "gone.md"]);
    await remove(w, "gone.md");
    expect(await paths(w)).toEqual(["keep.md"]);
  });

  it("lists an accepted proposal (the file holds its content), not a pending one", async () => {
    const w = await world();
    await seed(w, "accepted.md", "new text");
    await seed(w, "pending.md", "old");
    await events(w, [
      proposal("1", "/workspace/accepted.md", "new text"),
      proposal("2", "pending.md", "other text"),
    ]);
    expect(await paths(w)).toEqual(["accepted.md"]);
  });

  it("reads mirrored entries once the run's events are compacted", async () => {
    const w = await world();
    await seed(w, "report.md", "r");
    await seed(w, "err.md", "e");
    const at = tick();
    const entry = (entryId: string, parentId: string | null, message: Record<string, unknown>) => ({
      teamId: w.team,
      threadId: w.threadId,
      entryId,
      parentId,
      type: "message",
      payload: { type: "message", id: entryId, parentId, message },
      createdAt: at,
    });
    await withTeam(fx.db, w.team, (tx) =>
      tx.insert(threadEntries).values([
        entry("e1", null, {
          role: "assistant",
          content: [
            { type: "text", text: "writing" },
            {
              type: "toolCall",
              id: "c1",
              name: "write",
              arguments: { path: "/workspace/report.md" },
            },
            { type: "toolCall", id: "c2", name: "write", arguments: { path: "err.md" } },
          ],
        }),
        entry("e2", "e1", {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "write",
          isError: false,
          content: [],
        }),
        entry("e3", "e2", {
          role: "toolResult",
          toolCallId: "c2",
          toolName: "write",
          isError: true,
          content: [],
        }),
      ]),
    );
    expect(await paths(w)).toEqual(["report.md"]);
  });

  it("answers the owner only: a shared reader and another team get 404", async () => {
    const w = await world();
    await seed(w, "a.md", "a");
    await events(w, written("1", "write", "a.md"));
    const shared = await w.owner.browser.post(`/v1/threads/${w.threadId}/share`, {
      visibility: "team",
    });
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);
    const thread = await w.reader.browser.get(`/v1/threads/${w.threadId}`);
    expect(thread.status, "the reader can read the thread itself").toBe(200);
    expect((await list(w.reader, w.threadId)).status).toBe(404);

    const outsider = await fx.person(`x${randomBytes(2).toString("hex")}`);
    await fx.team(`tx-${randomBytes(3).toString("hex")}`, outsider);
    expect((await list(outsider, w.threadId)).status).toBe(404);
    expect((await list(w.owner, randomUUID())).status).toBe(404);
    expect((await list(w.owner, "not-a-uuid")).status).toBe(400);
    expect(await paths(w)).toEqual(["a.md"]);
  });

  it("pairs a call with its result by run: a repeated model id in another run is not its result", async () => {
    const w = await world();
    await seed(w, "failed.md", "f");
    await seed(w, "ok.md", "o");
    await events(w, written("call_0", "write", "failed.md", true));
    await events(w, written("call_0", "write", "ok.md"), await secondRun(w));
    expect(await paths(w)).toEqual(["ok.md"]);
  });

  it("pairs entries by order (repeated ids across runs) and caps them as a prefix", async () => {
    const w = await world();
    for (const p of ["a.md", "b.md", "c.md"]) await seed(w, p, p);
    await entries(w, [
      callMsg("call_0", "a.md"),
      resultMsg("call_0", true),
      callMsg("call_0", "b.md"),
      resultMsg("call_0"),
      callMsg("call_1", "c.md"),
      resultMsg("call_1"),
    ]);
    expect(await paths(w)).toEqual(["b.md", "c.md"]);
    // Four rows: the first two calls and their results, never calls without their results.
    const capped = await withTeam(fx.db, w.team, (tx) =>
      readAgentFiles(tx, { teamId: w.team, userId: w.owner.id }, w.threadId, { rowsMax: 4 }),
    );
    expect(capped.map((f) => f.path)).toEqual(["b.md"]);
  });

  it("leaves agent-internal paths out, proposals included", async () => {
    const w = await world();
    // The sync refuses agent-internal paths; move a synced row there to prove the filter.
    await seed(w, "state.md", "new");
    await fx.admin.query(
      `UPDATE workspace_files SET path = '.kobe/state.md' WHERE team_id = $1 AND path = 'state.md'`,
      [w.team],
    );
    await events(w, [
      ...written("1", "write", ".kobe/state.md"),
      proposal("2", ".kobe/state.md", "new"),
    ]);
    expect(await paths(w)).toEqual([]);
  });
});
