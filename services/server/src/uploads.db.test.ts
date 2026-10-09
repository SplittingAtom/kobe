import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UPLOAD_ERROR_HTTP_STATUS, uploadErrorSchema, uploadResponseSchema } from "@kobe/protocol";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { RawBody } from "./testing/browser.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { runWithAuditContext } from "./audit/context.js";
import { exportZip } from "./retention/export.js";
import { blobRecorder } from "./retention/job.js";
import { deleteReleasedBlobs, purgeThreads } from "./retention/index.js";
import { expireOrphanUploads } from "./uploads/expire.js";
import { storeUpload } from "./uploads/store.js";
import type { UploadSettings } from "./uploads/settings.js";

/**
 * KOBE-143: POST /v1/uploads end to end: S3 first then the files row, limits, the per-team quota
 * (atomic under concurrency), sniffing, audit, and the orphan sweep.
 */
const fx = new EventStreamFixture();
const objects = new MemoryObjects();
const PREFIX = "kobe/";
const blobs = { objects, prefix: PREFIX };
const settings: UploadSettings = {
  maxFileBytes: 1000,
  maxMessageBytes: 5000,
  defaultQuotaBytes: 2500,
  orphanHours: 24,
};

beforeAll(async () => {
  await fx.setup([{}], () => ({ blobs, uploads: settings }));
});
afterAll(() => fx.teardown());

let n = 0;
async function world() {
  const owner = await fx.person(`owner${n++}`);
  const team = await fx.team(`t-uploads-${n}`, owner);
  return { owner, team };
}

async function newThread(team: string, owner: Person): Promise<string> {
  const runId = await fx.run(team, owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  return must(rows[0], "thread").thread_id;
}

/** Serializes a multipart body the way a browser would. */
async function multipart(
  content: Uint8Array,
  opts: { name?: string; type?: string; threadId?: string } = {},
): Promise<RawBody> {
  const form = new FormData();
  if (opts.threadId) form.append("thread_id", opts.threadId);
  form.append(
    "file",
    new File([content as Uint8Array<ArrayBuffer>], opts.name ?? "notes.txt", {
      type: opts.type ?? "text/plain",
    }),
  );
  const req = new Request("http://x.test/", { method: "POST", body: form });
  return new RawBody(
    new Uint8Array(await req.arrayBuffer()),
    req.headers.get("content-type") ?? "",
  );
}

const upload = async (p: Person, bytes: Uint8Array, opts?: Parameters<typeof multipart>[1]) =>
  p.browser.post("/v1/uploads", await multipart(bytes, opts));

const filled = (size: number, v = 97) => new Uint8Array(size).fill(v);
const rowsOf = async (team: string) =>
  (await fx.admin.query(`SELECT * FROM files WHERE team_id = $1`, [team])).rows;
const auditOf = async (team: string, action: string) =>
  (
    await fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
      [team, action],
    )
  ).rows.map((r) => r.target);

describe("POST /v1/uploads", () => {
  it("stores a threaded file in the thread's tree, then the row, with sha256 and sniffed type", async () => {
    const { owner, team } = await world();
    const threadId = await newThread(team, owner);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const res = await upload(owner, png, { name: "pic.png", type: "text/plain", threadId });
    expect(res.status, res.text).toBe(201);
    const body = uploadResponseSchema.parse(res.json);
    expect(body).toMatchObject({
      name: "pic.png",
      mime_type: "image/png",
      size_bytes: 11,
      scan: "skipped",
    });
    const [row] = await rowsOf(team);
    expect(row).toMatchObject({
      id: body.file_id,
      user_id: owner.id,
      thread_id: threadId,
      kind: "upload",
      scan_status: "none",
      sha256: createHash("sha256").update(png).digest("hex"),
    });
    expect(row.blob_ref).toBe(`${PREFIX}teams/${team}/threads/${threadId}/uploads/${body.file_id}`);
    expect(objects.objects.get(row.blob_ref)).toEqual(Buffer.from(png));
    // The crash guard is cleared once the row committed.
    const queued = await fx.admin.query(
      `SELECT 1 FROM retention_blob_deletions WHERE team_id = $1`,
      [team],
    );
    expect(queued.rows).toHaveLength(0);
    expect(await auditOf(team, "workspace.upload_stored")).toEqual([
      { userId: owner.id, fileId: body.file_id, threadId, bytes: 11 },
    ]);
  });

  it("keeps a thread-less file in the uploader's tree", async () => {
    const { owner, team } = await world();
    const res = await upload(owner, filled(10));
    expect(res.status).toBe(201);
    const [row] = await rowsOf(team);
    expect(row.thread_id).toBeNull();
    expect(row.blob_ref).toBe(`${PREFIX}teams/${team}/users/${owner.id}/uploads/${row.id}`);
  });

  it("refuses an oversized file mid-stream and by Content-Length, storing and leaving nothing", async () => {
    const { owner, team } = await world();
    const res = await upload(owner, filled(1001));
    expect(res.status).toBe(UPLOAD_ERROR_HTTP_STATUS.file_too_large);
    expect(uploadErrorSchema.parse(res.json)).toMatchObject({
      code: "file_too_large",
      limit_bytes: 1000,
    });
    const big = await multipart(filled(70_000));
    const huge = await owner.browser.request("POST", "/v1/uploads", big, {
      "content-length": String(big.content.length),
    });
    expect(huge.status).toBe(413);
    expect(await rowsOf(team)).toHaveLength(0);
    expect(objects.keys(`${PREFIX}teams/${team}/`)).toEqual([]);
    const refused = await auditOf(team, "workspace.upload_refused");
    expect(refused).toEqual([
      { userId: owner.id, reason: "file_too_large", bytes: expect.any(Number) },
      { userId: owner.id, reason: "file_too_large", bytes: 0 },
    ]);
  });

  it("rejects another user's thread and bad forms with 404 / 400", async () => {
    const { owner, team } = await world();
    const other = await fx.person("other");
    await fx.addMember(team, other);
    await fx.activate(other, team);
    const threadId = await newThread(team, owner);
    expect((await upload(other, filled(5), { threadId })).status).toBe(404);
    expect((await upload(owner, filled(5), { threadId: randomUUID() })).status).toBe(404);
    const plain = await owner.browser.post("/v1/uploads", { not: "multipart" });
    expect(plain.status).toBe(400);
    expect(await rowsOf(team)).toHaveLength(0);
  });

  it("leaves no row when object storage fails", async () => {
    const { owner, team } = await world();
    const real = objects.putStream.bind(objects);
    objects.putStream = () => Promise.reject(new Error("bucket down"));
    try {
      const res = await upload(owner, filled(10));
      expect(res.status).toBe(503);
      expect(res.json).toMatchObject({ code: "storage_unavailable" });
    } finally {
      objects.putStream = real;
    }
    expect(await rowsOf(team)).toHaveLength(0);
  });
});

describe("team storage quota", () => {
  it("uses the install default, a team's own limit, and counts workspace bytes", async () => {
    const { owner, team } = await world();
    expect((await upload(owner, filled(1000))).status).toBe(201);
    expect((await upload(owner, filled(1000))).status).toBe(201);
    // 2000 used of 2500: 600 more does not fit; the object is deleted again.
    const over = await upload(owner, filled(600));
    expect(over.status).toBe(UPLOAD_ERROR_HTTP_STATUS.quota_exceeded);
    expect(over.json).toMatchObject({ code: "quota_exceeded" });
    expect(await rowsOf(team)).toHaveLength(2);
    expect(objects.keys(`${PREFIX}teams/${team}/`)).toHaveLength(2);
    // The team's own limit replaces the default.
    await fx.admin.query(
      `INSERT INTO team_storage_quotas (team_id, max_bytes, updated_by) VALUES ($1, 3000, $2)`,
      [team, owner.id],
    );
    expect((await upload(owner, filled(600))).status).toBe(201);
    // Live workspace bytes count too.
    await fx.admin.query(
      `INSERT INTO workspace_sync (team_id, user_id, live_bytes) VALUES ($1, $2, 400)`,
      [team, owner.id],
    );
    expect((await upload(owner, filled(1))).status).toBe(403);
    // null max_bytes = the install default again.
    await fx.admin.query(`UPDATE team_storage_quotas SET max_bytes = NULL WHERE team_id = $1`, [
      team,
    ]);
    expect((await upload(owner, filled(1))).status).toBe(403);
    expect(await auditOf(team, "workspace.upload_refused")).toHaveLength(3);
  });

  it("lets only what fits through when uploads race", async () => {
    const { owner, team } = await world();
    await fx.admin.query(
      `INSERT INTO team_storage_quotas (team_id, max_bytes, updated_by) VALUES ($1, 1500, $2)`,
      [team, owner.id],
    );
    const results = await Promise.all(Array.from({ length: 6 }, () => upload(owner, filled(800))));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 403, 403, 403, 403, 403]);
    expect(await rowsOf(team)).toHaveLength(1);
    expect(objects.keys(`${PREFIX}teams/${team}/`)).toHaveLength(1);
  });
});

describe("scan seam", () => {
  it("deletes the object and maps scanner outcomes to the contract's errors", async () => {
    const { owner, team } = await world();
    const deps = (scan: "rejected" | "unavailable" | "clean") => ({
      db: fx.db,
      blobs,
      settings,
      scan: () => Promise.resolve(scan),
    });
    const input = () => ({
      threadId: undefined,
      name: "a.bin",
      declaredMime: "",
      file: Readable.from([Buffer.from("abc")]),
      contentLength: undefined,
    });
    const caller = { teamId: team, userId: owner.id };
    const rejected = await storeUpload(deps("rejected"), caller, input());
    expect(rejected).toMatchObject({ ok: false, status: 422, body: { code: "scan_rejected" } });
    const down = await storeUpload(deps("unavailable"), caller, input());
    expect(down).toMatchObject({ ok: false, status: 503, body: { code: "scan_unavailable" } });
    expect(await rowsOf(team)).toHaveLength(0);
    expect(objects.keys(`${PREFIX}teams/${team}/`)).toEqual([]);
    const clean = await runWithAuditContext(
      { actor: { kind: "user", id: owner.id }, ip: null, userAgent: null },
      () => storeUpload(deps("clean"), caller, input()),
    );
    expect(clean).toMatchObject({ ok: true, file: { scan: "clean" } });
  });
});

describe("orphan sweep", () => {
  it("deletes old thread-less uploads, keeping threaded, fresh and held ones", async () => {
    const { owner, team } = await world();
    const held = await fx.person("held");
    await fx.addMember(team, held);
    await fx.activate(held, team);
    const threadId = await newThread(team, owner);
    const old = must((await upload(owner, filled(10))).json as { file_id: string }, "old");
    const fresh = must((await upload(owner, filled(10))).json as { file_id: string }, "fresh");
    const threaded = must(
      (await upload(owner, filled(10), { threadId })).json as { file_id: string },
      "t",
    );
    const heldFile = must((await upload(held, filled(10))).json as { file_id: string }, "held");
    await fx.admin.query(
      `UPDATE files SET created_at = now() - interval '25 hours' WHERE id = ANY($1::uuid[])`,
      [[old.file_id, threaded.file_id, heldFile.file_id]],
    );
    const create = (installRole: "owner" | "admin") =>
      fx.replica(0).deps.createUserWithPassword(
        {
          email: `${installRole}-${randomUUID().slice(0, 6)}@hold.test`,
          name: installRole,
          password: "correct horse battery 1",
        },
        { installRole },
      );
    const [installOwner, installAdmin] = [await create("owner"), await create("admin")];
    const hold = await fx.admin.query<{ id: string }>(
      `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
      [team, held.id, installAdmin.id],
    );
    await fx.admin.query(
      `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
      [must(hold.rows[0], "hold").id, installOwner.id],
    );
    const counts = await expireOrphanUploads(fx.db, team, blobs, 24);
    expect(counts).toEqual({ files: 1, bytes: 10 });
    const left = (await rowsOf(team)).map((r) => r.id as string).sort();
    expect(left).toEqual([fresh.file_id, threaded.file_id, heldFile.file_id].sort());
    expect(await auditOf(team, "workspace.uploads_expired")).toEqual([{ files: 1, bytes: 10 }]);
  });
});

describe("retention and export", () => {
  it("exports a thread's files and purges them with the thread", async () => {
    const { owner, team } = await world();
    const runId = await fx.run(team, owner);
    const { rows } = await fx.admin.query<{ thread_id: string }>(
      `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
      [team, runId],
    );
    const threadId = must(rows[0], "thread").thread_id;
    const res = await upload(owner, new TextEncoder().encode("hello export"), { threadId });
    const id = (res.json as { file_id: string }).file_id;

    const chunks: Uint8Array[] = [];
    for await (const c of exportZip(fx.db, { teamId: team, userId: owner.id }, blobs))
      chunks.push(c);
    const zip = unzipSync(Buffer.concat(chunks));
    expect(strFromU8(zip[`files/${id}/notes.txt`] ?? new Uint8Array())).toBe("hello export");

    await fx.complete(team, runId);
    const outcome = await purgeThreads(
      fx.db,
      team,
      { kind: "user", userId: owner.id },
      async () => {},
    );
    expect(outcome).toMatchObject({ status: "done", counts: { threads: 1, blobs: 1 } });
    expect(await rowsOf(team)).toEqual([]);
    await deleteReleasedBlobs(fx.db, team, blobs, blobRecorder(team), { maxBatches: 5 });
    expect(objects.keys(`${PREFIX}teams/${team}/`)).toEqual([]);
  });
});
