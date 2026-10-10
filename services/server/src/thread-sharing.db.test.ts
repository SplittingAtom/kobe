import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunFixture } from "./testing/run-fixture.js";
import { SseReader } from "./testing/sse.js";
import type { Person } from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { runRetentionPass, type BlobStore } from "./retention/index.js";

/**
 * KOBE-163: share a thread to its project, read-only access for members, unshare, fork (D23).
 * A reader is a project member who is not the author; everyone else gets 404.
 */
const f = new RunFixture();
const objects = new MemoryObjects();
const PREFIX = "kobe/";
const blobs: BlobStore = { objects, prefix: PREFIX };

beforeAll(async () => {
  await f.setup({ blobs, streamTimings: { keepaliveMs: 50, revalidateMs: 100 } });
});
afterAll(async () => {
  await f.teardown();
});

const as = (p: Person) => f.on(0, p);

/** A team with a selected-mode project (author + reader inside, outsider outside) and one run. */
async function world(settle = true) {
  const w = await f.world();
  const author = w.owner;
  const reader = await f.member(w.team);
  const outsider = await f.member(w.team);
  const project = await as(author).post("/v1/projects", {
    name: "Shared",
    members_mode: "selected",
    member_user_ids: [reader.id],
  });
  expect(project.status, JSON.stringify(project.json)).toBe(201);
  const made = await as(author).post("/v1/threads", {
    project_id: project.json.id,
    title: "plan",
  });
  const threadId = made.json.thread_id as string;
  const ws = await f.connect(w, 0);
  const runId = await f.message(author, threadId, "hello");
  const start = await ws.started(runId);
  const entries = ws.reply(start, "world", settle);
  await ws.acked(runId);
  if (settle) await f.until(w.team, runId, "completed");
  return {
    w,
    author,
    reader,
    outsider,
    projectId: project.json.id as string,
    threadId,
    runId,
    entries,
  };
}

async function audit(team: string, action: string) {
  const { rows } = await f.fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
    [team, action],
  );
  return rows.map((r) => r.target);
}

describe("share and unshare", () => {
  it("shares to the project, readable by members only, and unshare hides it again", async () => {
    const x = await world();
    const url = `/v1/threads/${x.threadId}`;
    expect((await as(x.reader).get(url)).status).toBe(404);
    const shared = await as(x.author).post(`${url}/share`, { visibility: "project" });
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);
    expect(shared.json).toMatchObject({ visibility: "project", shared_to_project: true });
    const seen = await as(x.reader).get(url);
    expect(seen.status).toBe(200);
    expect(seen.json).toMatchObject({ read_only: true, visibility: "project" });
    expect(seen.json.entries.length).toBeGreaterThan(0);
    expect((await as(x.author).get(url)).json.read_only).toBe(false);
    expect((await as(x.outsider).get(url)).status).toBe(404);
    expect((await as(x.outsider).get(`${url}/entries`)).status).toBe(404);
    // The run stream follows the thread's visibility.
    const seq = (await f.events(x.w.team, x.runId)).length;
    const stream = `/v1/runs/${x.runId}/events?starting_after=${seq}`;
    expect((await as(x.reader).get(stream)).status).toBe(204);
    expect((await as(x.outsider).get(stream)).status).toBe(404);

    const back = await as(x.author).post(`${url}/share`, { visibility: "private" });
    expect(back.json.visibility).toBe("private");
    expect((await as(x.reader).get(url)).status).toBe(404);
    expect((await as(x.reader).get(stream)).status).toBe(404);
    expect(await audit(x.w.team, "thread.sharing_changed")).toEqual([
      { threadId: x.threadId, projectId: x.projectId, shared: true, visibility: "project" },
      { threadId: x.threadId, projectId: x.projectId, shared: false, visibility: "private" },
    ]);
  });

  it("is the author's call, needs a project and a valid scope", async () => {
    const x = await world();
    await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "project" });
    const url = `/v1/threads/${x.threadId}/share`;
    const refused = await as(x.reader).post(url, { visibility: "private" });
    expect([refused.status, refused.json.code]).toEqual([403, "read_only"]);
    expect((await as(x.outsider).post(url, { visibility: "private" })).status).toBe(404);
    expect((await as(x.author).post(url, { visibility: "team" })).status).toBe(400);
    const loose = await f.thread(x.author);
    const noProject = await as(x.author).post(`/v1/threads/${loose}/share`, {
      visibility: "project",
    });
    expect([noProject.status, noProject.json.code]).toEqual([409, "not_in_project"]);
  });

  it("hides a shared thread while it is in Trash", async () => {
    const x = await world();
    const url = `/v1/threads/${x.threadId}`;
    await as(x.author).post(`${url}/share`, { visibility: "project" });
    expect((await as(x.author).delete(url)).status).toBe(200);
    expect((await as(x.reader).get(url)).status).toBe(404);
    const seq = (await f.events(x.w.team, x.runId)).length;
    expect(
      (await as(x.reader).get(`/v1/runs/${x.runId}/events?starting_after=${seq}`)).status,
    ).toBe(404);
  });
});

describe("read-only enforcement", () => {
  it("answers 403 read_only to a reader on every mutating route", async () => {
    const x = await world();
    await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "project" });
    const t = `/v1/threads/${x.threadId}`;
    const r = as(x.reader);
    const attempts = [
      await r.patch(t, { title: "mine now" }),
      await r.post(`${t}/leaf`, { entry_id: x.entries.user }),
      await r.post(`${t}/agent-version`, {}),
      await r.delete(t),
      await r.post(`${t}/restore`, {}),
      await r.post(`${t}/messages`, { content: "hi" }),
      await r.post(`${t}/queue/resume`, {}),
      await r.post(`/v1/runs/${x.runId}/steer`, { content: "x" }),
      await r.post(`/v1/runs/${x.runId}/cancel`, {}),
      await r.post(`/v1/runs/${x.runId}/retry`, {}),
      await r.patch(`/v1/runs/${x.runId}`, { content: "x" }),
      await r.post(`${t}/share`, { visibility: "private" }),
    ];
    for (const res of attempts) {
      expect([res.status, res.json.code], JSON.stringify(res.json)).toEqual([403, "read_only"]);
    }
    // Purge is the author's, and an approval is decided by its asker only: both are 404 to a reader.
    expect((await r.post(`${t}/purge`, {})).status).toBe(404);
    const approvalId = randomUUID();
    await f.fx.admin.query(
      `INSERT INTO approvals (team_id, id, run_id, thread_id, user_id, connection_id, tool_call_id,
                              tool, input_canonical, risk, reasons, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, gen_random_uuid(), 'tc-1', 'bash', '{}', 'write', '[]',
               'pending', now() + interval '1 hour')`,
      [x.w.team, approvalId, x.runId, x.threadId, x.author.id],
    );
    expect((await r.post(`/v1/approvals/${approvalId}`, { decision: "allow" })).status).toBe(404);
    const pending = await f.fx.admin.query(`SELECT status FROM approvals WHERE id = $1`, [
      approvalId,
    ]);
    expect(pending.rows[0]).toEqual({ status: "pending" });
    // Nothing changed.
    const still = await as(x.author).get(t);
    expect(still.json).toMatchObject({ title: "plan", deleted_at: null });
    // Queued drafts and approvals belong to the author: invisible to the reader.
    expect((await r.get(`${t}/pending-messages`)).json.messages ?? []).toEqual([]);
    expect((await r.get("/v1/approvals")).json.approvals).toEqual([]);
  });

  it("gives an outsider the same 404 as for a missing thread", async () => {
    const x = await world();
    await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "project" });
    const o = as(x.outsider);
    const t = `/v1/threads/${x.threadId}`;
    for (const res of [
      await o.patch(t, { title: "x" }),
      await o.post(`${t}/messages`, { content: "hi" }),
      await o.post(`/v1/runs/${x.runId}/cancel`, {}),
      await o.post(`${t}/fork`, {}),
    ]) {
      expect(res.status).toBe(404);
    }
  });
});

describe("fork", () => {
  it("copies the conversation into the forker's own private thread and audits it", async () => {
    const x = await world();
    const url = `/v1/threads/${x.threadId}`;
    expect((await as(x.reader).post(`${url}/fork`, {})).status).toBe(404); // not shared yet
    await as(x.author).post(`${url}/share`, { visibility: "project" });
    const forked = await as(x.reader).post(`${url}/fork`, {});
    expect(forked.status, JSON.stringify(forked.json)).toBe(201);
    const id = forked.json.thread_id as string;
    const mine = await as(x.reader).get(`/v1/threads/${id}`);
    expect(mine.json).toMatchObject({
      owner_user_id: x.reader.id,
      project_id: x.projectId,
      visibility: "private",
      read_only: false,
      title: "plan",
      leaf_entry_id: x.entries.assistant,
    });
    expect(mine.json.entries.map((e: { entry_id: string }) => e.entry_id)).toEqual(
      (await as(x.author).get(url)).json.entries.map((e: { entry_id: string }) => e.entry_id),
    );
    // Private to the forker; the source is untouched.
    expect((await as(x.author).get(`/v1/threads/${id}`)).status).toBe(404);
    expect((await as(x.reader).patch(`/v1/threads/${id}`, { title: "mine" })).status).toBe(200);
    expect((await as(x.author).get(url)).json.title).toBe("plan");
    expect(await audit(x.w.team, "thread.forked")).toEqual([
      { threadId: id, sourceThreadId: x.threadId, projectId: x.projectId, entries: 2 },
    ]);
    // Unsharing hides the source from forking again.
    await as(x.author).post(`${url}/share`, { visibility: "private" });
    expect((await as(x.reader).post(`${url}/fork`, {})).status).toBe(404);
  });

  it("copies an offloaded entry body into the fork's own tree, so purging the source keeps it", async () => {
    const x = await world();
    const team = x.w.team;
    const sourceKey = `${PREFIX}teams/${team}/threads/${x.threadId}/entries/big`;
    const body = Buffer.from(JSON.stringify({ message: { role: "user", content: "x".repeat(70_000) } }));
    objects.objects.set(sourceKey, body);
    await f.fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload, blob_ref)
       VALUES ($1, $2, 'big', $3, 'message', '{}', $4)`,
      [team, x.threadId, x.entries.assistant, sourceKey],
    );
    await f.fx.admin.query(`UPDATE threads SET leaf_entry_id = 'big' WHERE team_id = $1 AND id = $2`, [
      team,
      x.threadId,
    ]);
    const forked = await as(x.author).post(`/v1/threads/${x.threadId}/fork`, {});
    expect(forked.status, JSON.stringify(forked.json)).toBe(201);
    const id = forked.json.thread_id as string;
    const { rows } = await f.fx.admin.query<{ blob_ref: string }>(
      `SELECT blob_ref FROM thread_entries WHERE team_id = $1 AND thread_id = $2 AND entry_id = 'big'`,
      [team, id],
    );
    const copy = rows[0]?.blob_ref ?? "";
    expect(copy).not.toBe(sourceKey);
    expect(copy.startsWith(`${PREFIX}teams/${team}/threads/${id}/`)).toBe(true);
    expect(objects.objects.get(copy)).toEqual(body);

    // Purge the source (trashed long ago): its blob goes, the fork's copy stays readable.
    await f.fx.admin.query(
      `UPDATE threads SET deleted_at = now() - interval '400 days' WHERE team_id = $1 AND id = $2`,
      [team, x.threadId],
    );
    await runRetentionPass({ db: f.fx.db, blobs, logger: pino({ level: "silent" }) });
    expect(objects.objects.has(sourceKey)).toBe(false);
    expect(objects.objects.get(copy)).toEqual(body);
    const detail = await as(x.author).get(`/v1/threads/${id}`);
    expect(detail.json.entries.at(-1)).toMatchObject({ entry_id: "big", payload_offloaded: true });
    expect(await audit(team, "thread.forked")).toContainEqual({
      threadId: id,
      sourceThreadId: x.threadId,
      projectId: x.projectId,
      entries: 3,
    });
  });

  it("deletes the copied bodies when the fork cannot be stored", async () => {
    const x = await world();
    const team = x.w.team;
    const sourceKey = `${PREFIX}teams/${team}/threads/${x.threadId}/entries/big2`;
    objects.objects.set(sourceKey, Buffer.from("{}"));
    await f.fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload, blob_ref)
       VALUES ($1, $2, 'big2', $3, 'message', '{}', $4)`,
      [team, x.threadId, x.entries.assistant, sourceKey],
    );
    await f.fx.admin.query(`UPDATE threads SET leaf_entry_id = 'big2' WHERE team_id = $1 AND id = $2`, [
      team,
      x.threadId,
    ]);
    // A reader who lost access between planning and storing is the 404 path; here the source
    // is trashed after the copy would start, which the second transaction re-checks.
    const before = new Set(objects.objects.keys());
    const real = objects.copy.bind(objects);
    objects.copy = async (from, to) => {
      await real(from, to);
      await f.fx.admin.query(
        `UPDATE threads SET deleted_at = now() WHERE team_id = $1 AND id = $2`,
        [team, x.threadId],
      );
    };
    const res = await as(x.author).post(`/v1/threads/${x.threadId}/fork`, {});
    objects.copy = real;
    expect(res.status).toBe(409);
    expect(new Set(objects.objects.keys())).toEqual(before);
  });

  it("forks up to an entry, with a new title, and the author may fork their own thread", async () => {
    const x = await world();
    const url = `/v1/threads/${x.threadId}/fork`;
    const cut = await as(x.author).post(url, { entry_id: x.entries.user, title: "Take 2" });
    expect(cut.status, JSON.stringify(cut.json)).toBe(201);
    const detail = await as(x.author).get(`/v1/threads/${cut.json.thread_id}`);
    expect(detail.json).toMatchObject({ title: "Take 2", leaf_entry_id: x.entries.user });
    expect(detail.json.entries).toHaveLength(1);
    const missing = await as(x.author).post(url, { entry_id: "nope" });
    expect([missing.status, missing.json.code]).toEqual([404, "entry_not_found"]);
    expect((await as(x.author).post(url, { extra: 1 })).status).toBe(400);
  });
});

describe("sharing needs a usable project", () => {
  it("refuses a removed member and an archived project with the missing-project 404", async () => {
    const x = await world();
    const member = await f.member(x.w.team);
    await as(x.author).post(`/v1/projects/${x.projectId}/members`, { user_id: member.id });
    const made = await as(member).post("/v1/threads", { project_id: x.projectId });
    const id = made.json.thread_id as string;
    const share = `/v1/threads/${id}/share`;
    await as(x.author).delete(`/v1/projects/${x.projectId}/members/${member.id}`);
    const removed = await as(member).post(share, { visibility: "project" });
    expect([removed.status, removed.json.code]).toEqual([404, "project_not_found"]);
    // Unsharing is never blocked.
    expect((await as(member).post(share, { visibility: "private" })).status).toBe(200);

    await as(x.author).post(`/v1/projects/${x.projectId}/members`, { user_id: member.id });
    await as(x.author).patch(`/v1/projects/${x.projectId}`, { archived: true });
    const archived = await as(member).post(share, { visibility: "project" });
    expect([archived.status, archived.json.code]).toEqual([404, "project_not_found"]);
  });
});

describe("reader streams", () => {
  it("lets a reader watch a live run, refuses a non-reader, and ends when access is revoked", async () => {
    for (const revoke of ["unshare", "removal"] as const) {
      const x = await world(false);
      await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "project" });
      expect((await f.fx.open(0, x.outsider, x.runId)).status).toBe(404);
      const res = await f.fx.open(0, x.reader, x.runId);
      expect(res.status).toBe(200);
      const sse = new SseReader(res.body);
      expect((await sse.nextEvent())?.run_id).toBe(x.runId);
      if (revoke === "unshare") {
        await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "private" });
      } else {
        await as(x.author).delete(`/v1/projects/${x.projectId}/members/${x.reader.id}`);
      }
      // Revalidation (every revalidateMs; 30 s in production) closes the stream.
      const ended = await Promise.race([
        sse.rest().then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
      ]);
      expect(ended, revoke).toBe(true);
    }
  });
});
