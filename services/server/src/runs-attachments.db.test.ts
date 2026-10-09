import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UPLOAD_ATTACHMENT_ROOT } from "@kobe/protocol";
import type { Person } from "./testing/event-stream-fixture.js";
import { RawBody } from "./testing/browser.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { RunFixture } from "./testing/run-fixture.js";
import { blobRecorder } from "./retention/job.js";
import { deleteReleasedBlobs, purgeThreads } from "./retention/index.js";
import { createAttachmentStager } from "./uploads/attach.js";
import type { UploadSettings } from "./uploads/settings.js";
import { workspaceBlobKey } from "./workspace-sync/keys.js";
import { createWorkspaceSync } from "./workspace-sync/service.js";
import { logger } from "./logger.js";

/**
 * KOBE-144: message submit with file_ids: validation, copy into the thread's tree and the
 * workspace, the manifest write the sandbox pulls, `run.start.attachments`, retention.
 */
const f = new RunFixture();
const objects = new MemoryObjects();
const PREFIX = "kobe/";
const blobs = { objects, prefix: PREFIX };
const settings: UploadSettings = {
  maxFileBytes: 1000,
  maxMessageBytes: 100,
  defaultQuotaBytes: 1_000_000,
  orphanHours: 24,
};

beforeAll(async () => {
  await f.setup({ blobs });
  for (let i = 0; i < f.fx.replicas.length; i += 1) {
    const sync = createWorkspaceSync({
      db: f.fx.db,
      objects,
      prefix: PREFIX,
      limits: { maxFileBytes: 1000, maxWorkspaceBytes: 100_000, maxFiles: 100 },
      log: logger,
    });
    f.fx
      .replica(i)
      .deps.runs.useAttachments(createAttachmentStager({ db: f.fx.db, sync, settings }));
  }
});
afterAll(() => f.teardown());

async function upload(p: Person, text: string, name = "notes.txt"): Promise<string> {
  const form = new FormData();
  form.append("file", new File([text], name, { type: "text/plain" }));
  const req = new Request("http://x.test/", { method: "POST", body: form });
  const body = new RawBody(
    new Uint8Array(await req.arrayBuffer()),
    req.headers.get("content-type") ?? "",
  );
  const res = await p.browser.post("/v1/uploads", body);
  expect(res.status, res.text).toBe(201);
  return res.json.file_id as string;
}

const fileRow = async (team: string, id: string) =>
  (
    await f.fx.admin.query(
      `SELECT thread_id, run_id, blob_ref FROM files WHERE team_id = $1 AND id = $2`,
      [team, id],
    )
  ).rows[0];

const manifest = async (team: string, user: string) =>
  (
    await f.fx.admin.query<{ path: string; blob_key: string; deleted: boolean }>(
      `SELECT path, blob_key, deleted FROM workspace_files WHERE team_id = $1 AND user_id = $2 ORDER BY path`,
      [team, user],
    )
  ).rows;

describe("message with file_ids", () => {
  it("syncs the upload into the workspace, moves it into the thread tree and sends the attachment", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const id = await upload(w.owner, "a,b\n1,2\n", "sales.csv");
    const userKey = `${PREFIX}teams/${w.team}/users/${w.owner.id}/uploads/${id}`;
    expect(objects.objects.has(userKey)).toBe(true);

    const res = await f.send(w.owner, threadId, "look at this", 0, { file_ids: [id] });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const start = await ws.started(res.json.run_id as string);
    expect(start.attachments).toEqual([
      {
        path: `${UPLOAD_ATTACHMENT_ROOT}/${threadId}/sales.csv`,
        mime_type: "text/plain",
        name: "sales.csv",
        size_bytes: 8,
      },
    ]);

    const sha = createHash("sha256").update("a,b\n1,2\n").digest("hex");
    const rows = await manifest(w.team, w.owner.id);
    expect(rows).toEqual([
      {
        path: `uploads/${threadId}/sales.csv`,
        blob_key: workspaceBlobKey(PREFIX, { teamId: w.team, userId: w.owner.id }, sha),
        deleted: false,
      },
    ]);
    expect(objects.objects.get(must(rows[0]).blob_key)?.toString()).toBe("a,b\n1,2\n");

    // Attached to the thread and run, object moved into the thread's own tree, old one gone.
    const threadKey = `${PREFIX}teams/${w.team}/threads/${threadId}/uploads/${id}`;
    expect(await fileRow(w.team, id)).toMatchObject({
      thread_id: threadId,
      run_id: res.json.run_id,
      blob_ref: threadKey,
    });
    expect(objects.objects.has(threadKey)).toBe(true);
    expect(objects.objects.has(userKey)).toBe(false);
    const pending = await f.fx.admin.query(
      `SELECT 1 FROM retention_blob_deletions WHERE team_id = $1`,
      [w.team],
    );
    expect(pending.rows).toHaveLength(0);
  });

  it("numbers repeated names and gives a queued run its files when it starts", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const first = await f.message(w.owner, threadId, "go");
    const a = await upload(w.owner, "one");
    const b = await upload(w.owner, "two");
    const queued = await f.send(w.owner, threadId, "later", 0, { file_ids: [a, b] });
    expect(queued.json.queued).toBe(true);
    const start1 = await ws.started(first);
    ws.reply(start1, "done");
    await f.until(w.team, first, "completed");
    const start2 = await ws.started(queued.json.run_id as string);
    expect(start2.attachments?.map((x) => x.path)).toEqual([
      `${UPLOAD_ATTACHMENT_ROOT}/${threadId}/notes.txt`,
      `${UPLOAD_ATTACHMENT_ROOT}/${threadId}/notes-2.txt`,
    ]);
    expect((await manifest(w.team, w.owner.id)).map((r) => r.path)).toEqual([
      `uploads/${threadId}/notes-2.txt`,
      `uploads/${threadId}/notes.txt`,
    ]);
  });

  it("refuses unknown, foreign, other-thread and reused files, leaving nothing attached", async () => {
    const w = await f.world(1);
    const other = must(w.others[0]);
    await f.fx.activate(other, w.team);
    const threadId = await f.thread(w.owner);
    const otherThread = await f.thread(w.owner);
    const mine = await upload(w.owner, "mine");
    const theirs = await upload(other, "theirs");
    const bound = await upload(w.owner, "bound");
    await f.fx.admin.query(`UPDATE files SET thread_id = $3 WHERE team_id = $1 AND id = $2`, [
      w.team,
      bound,
      otherThread,
    ]);

    for (const ids of [[randomUUID()], [theirs], [bound], [mine, theirs]]) {
      const res = await f.send(w.owner, threadId, "x", 0, { file_ids: ids });
      expect(res.status, JSON.stringify(ids)).toBe(404);
      expect(res.json.code).toBe("file_not_found");
    }
    expect((await fileRow(w.team, mine))?.run_id).toBeNull();
    expect(await f.fx.admin.query(`SELECT 1 FROM runs WHERE team_id = $1`, [w.team])).toMatchObject(
      { rows: [] },
    );

    const ok = await f.send(w.owner, threadId, "x", 0, { file_ids: [mine] });
    expect(ok.status).toBe(201);
    const again = await f.send(w.owner, threadId, "y", 0, { file_ids: [mine] });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("file_in_use");
  });

  it("enforces the per-message total", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    const a = await upload(w.owner, "x".repeat(60));
    const b = await upload(w.owner, "y".repeat(60));
    const res = await f.send(w.owner, threadId, "x", 0, { file_ids: [a, b] });
    expect(res.status).toBe(413);
    expect(res.json.code).toBe("message_too_large");
    expect(objects.keys(`${PREFIX}teams/${w.team}/threads/`)).toEqual([]);
  });

  it("deletes the attached object with the thread", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    const id = await upload(w.owner, "bye");
    const run = await f.send(w.owner, threadId, "x", 0, { file_ids: [id] });
    expect(run.status).toBe(201);
    const runId = run.json.run_id as string;
    await f.fx.complete(w.team, runId);
    const outcome = await purgeThreads(
      f.fx.db,
      w.team,
      { kind: "user", userId: w.owner.id },
      async () => {},
    );
    expect(outcome).toMatchObject({ status: "done" });
    await deleteReleasedBlobs(f.fx.db, w.team, blobs, blobRecorder(w.team), { maxBatches: 5 });
    expect(objects.keys(`${PREFIX}teams/${w.team}/threads/`)).toEqual([]);
    expect(objects.keys(`${PREFIX}teams/${w.team}/users/${w.owner.id}/uploads/`)).toEqual([]);
  });
});

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("missing");
  return v;
}
