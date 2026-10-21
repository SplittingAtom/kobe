import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITY_FILE_EDITS, VIEWING_CONTENT_MAX_BYTES } from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { MemoryObjects } from "./testing/memory-objects.js";
import { RunFixture, type RunWorld } from "./testing/run-fixture.js";
import { must } from "./testing/event-stream-fixture.js";
import { createViewingReader } from "./workspace-files/viewing.js";
import {
  createWorkspaceSync,
  workspaceBlobKey,
  type WorkspaceSync,
} from "./workspace-sync/index.js";

/**
 * KOBE-462 (spec FE6): a message's `viewing {path}` reaches its run as `run.start.viewing`, read
 * from the sender's own synced workspace, bounded, text only, never in the message text, and only
 * for agents that announced `file_edits`.
 */
const f = new RunFixture();
const objects = new MemoryObjects();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 1024 * 1024, maxWorkspaceBytes: 4 * 1024 * 1024, maxFiles: 50 };
let sync: WorkspaceSync;
let reads = 0;

beforeAll(async () => {
  await f.setup();
  sync = createWorkspaceSync({ db: f.fx.db, objects, prefix: "", limits: LIMITS, log: silent });
  const reader = createViewingReader(f.fx.db, sync);
  f.fx.replica(0).deps.runs.useViewing((owner, path) => {
    reads += 1;
    return reader(owner, path);
  });
});
afterAll(() => f.teardown());

const CAPS = ["skill_bundles", CAPABILITY_FILE_EDITS];
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function seed(w: RunWorld, userId: string, path: string, data: Buffer): Promise<string> {
  const owner = { teamId: w.team, userId };
  const hash = sha(data);
  const key = workspaceBlobKey("", owner, hash);
  objects.objects.set(key, data);
  await withTeam(f.fx.db, w.team, (tx) =>
    sync.putServerFile(tx, owner, { path, sha256: hash, size: data.length, blobKey: key }, "user"),
  );
  return hash;
}

async function sendViewing(w: RunWorld, path: string, capabilities = CAPS) {
  const ws = await f.connect(w, 0, capabilities);
  const threadId = await f.thread(w.owner);
  const res = await f.send(w.owner, threadId, "Tighten this", 0, { viewing: { path } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  const runId = res.json.run_id as string;
  return { runId, start: await ws.started(runId), ws, threadId };
}

const viewingRow = async (runId: string) =>
  (await f.fx.admin.query<{ viewing: unknown }>(`SELECT viewing FROM runs WHERE id = $1`, [runId]))
    .rows[0]?.viewing;

describe("viewed-file context (KOBE-462)", () => {
  it("reaches run.start with the file's version and text, not the message (ac-3)", async () => {
    const w = await f.world();
    const hash = await seed(w, w.owner.id, "notes/plan.md", Buffer.from("# Plan\n"));
    const { runId, start } = await sendViewing(w, "notes/plan.md");
    expect(start.viewing).toEqual({
      path: "notes/plan.md",
      sha256: hash,
      size: 7,
      content: "# Plan\n",
      truncated: false,
    });
    expect(start.message).toBe("Tighten this");
    expect((await f.run(w.team, runId)).input).toBe("Tighten this");
  });

  it("is bounded: a long file is cut and marked truncated", async () => {
    const w = await f.world();
    const long = Buffer.from("x".repeat(VIEWING_CONTENT_MAX_BYTES + 100));
    await seed(w, w.owner.id, "long.txt", long);
    const { start } = await sendViewing(w, "long.txt");
    expect(start.viewing?.content?.length).toBe(VIEWING_CONTENT_MAX_BYTES);
    expect(start.viewing?.truncated).toBe(true);
    expect(start.viewing?.size).toBe(long.length);
  });

  it("sends no content for a binary file, only its path and version", async () => {
    const w = await f.world();
    await seed(w, w.owner.id, "image.png", Buffer.from([0x89, 0x50, 0x00, 0xff]));
    const { start } = await sendViewing(w, "image.png");
    expect(start.viewing?.path).toBe("image.png");
    expect(start.viewing?.content).toBeUndefined();
    expect(start.viewing?.truncated).toBe(false);
  });

  it("reads the sender's own workspace only; unknown and internal paths add nothing", async () => {
    const w = await f.world(1);
    const other = w.others[0];
    if (!other) throw new Error("no member");
    await seed(w, other.id, "theirs.md", Buffer.from("secret\n"));
    for (const path of ["theirs.md", "missing.md", ".kobe/state.md"]) {
      const { start } = await sendViewing(w, path);
      expect(start.viewing).toBeUndefined();
    }
  });

  it("is left out for an agent without file_edits", async () => {
    const w = await f.world();
    await seed(w, w.owner.id, "a.md", Buffer.from("a\n"));
    const { runId, start } = await sendViewing(w, "a.md", ["skill_bundles"]);
    expect(start.viewing).toBeUndefined();
    const { rows } = await f.fx.admin.query<{ viewing: unknown }>(
      `SELECT viewing FROM runs WHERE id = $1`,
      [runId],
    );
    expect(rows[0]?.viewing).toMatchObject({ path: "a.md" });
  });

  it("keeps only the path and version once the run ends (review)", async () => {
    const w = await f.world();
    const hash = await seed(w, w.owner.id, "done.md", Buffer.from("secret text\n"));
    const { runId, start, ws } = await sendViewing(w, "done.md");
    expect(await viewingRow(runId)).toMatchObject({ content: "secret text\n" });
    ws.reply(start, "Done.");
    await f.until(w.team, runId, "completed");
    expect(await viewingRow(runId)).toEqual({ path: "done.md", sha256: hash });
  });

  it("is read again for a retry of the run (FE7)", async () => {
    const w = await f.world();
    await seed(w, w.owner.id, "a.md", Buffer.from("a\n"));
    const { runId } = await sendViewing(w, "a.md");
    await f.fx.admin.query(
      `UPDATE runs SET status = 'interrupted', ended_at = now() WHERE id = $1;`,
      [runId],
    );
    await f.fx.admin.query(
      `UPDATE threads SET status = 'interrupted'
        WHERE id = (SELECT thread_id FROM runs WHERE id = $1)`,
      [runId],
    );
    await seed(w, w.owner.id, "a.md", Buffer.from("b\n"));
    const retry = await w.owner.browser.post(`/v1/runs/${runId}/retry`);
    expect(retry.status, JSON.stringify(retry.json)).toBe(201);
    // Read again from the workspace: the original's text was not kept.
    expect(await viewingRow(retry.json.run_id as string)).toMatchObject({
      path: "a.md",
      content: "b\n",
    });
  });

  it("reads nothing for someone who is not the thread's owner (review)", async () => {
    const w = await f.world(1);
    const other = must(w.others[0], "member");
    await seed(w, other.id, "theirs.md", Buffer.from("x\n"));
    const threadId = await f.thread(w.owner);
    const before = reads;
    const res = await f.send(other, threadId, "x", 0, { viewing: { path: "theirs.md" } });
    expect(res.status).toBe(404);
    expect(reads).toBe(before);
  });

  it("refuses a path that is not a workspace path", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    const res = await f.send(w.owner, threadId, "x", 0, { viewing: { path: "/etc/passwd" } });
    expect(res.status).toBe(400);
  });
});
