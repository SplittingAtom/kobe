import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { threadMarkersSchema } from "./routes/thread-markers.js";
import { RunFixture } from "./testing/run-fixture.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * Pin, archive and move to project (CE19, KOBE-220): the owner's own organization of their
 * threads. Pinned threads leave the activity list for `GET /v1/threads/pinned` (by pin time);
 * archived ones for `GET /v1/threads/archived`, still found by search. A move needs the right to
 * start a thread in the target project and marks the next run.
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

const as = (p: Person) => f.on(0, p);

const ids = (res: { json: { threads: { thread_id: string }[] } }) =>
  res.json.threads.map((t) => t.thread_id);

async function activity(team: string, threadId: string): Promise<string> {
  const { rows } = await f.fx.admin.query<{ at: string }>(
    `SELECT last_activity_at::text AS at FROM threads WHERE team_id = $1 AND id = $2`,
    [team, threadId],
  );
  return rows[0]?.at ?? "";
}

async function audit(team: string, action: string) {
  const { rows } = await f.fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
    [team, action],
  );
  return rows.map((r) => r.target);
}

async function project(p: Person, name: string, body: Record<string, unknown> = {}) {
  const res = await as(p).post("/v1/projects", { name, ...body });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.id as string;
}

describe("pin and unpin", () => {
  it("moves a thread to the Pinned list by pin time and back, never touching its activity", async () => {
    const w = await f.world();
    const a = await f.thread(w.owner);
    const b = await f.thread(w.owner);
    const c = await f.thread(w.owner);
    const before = await activity(w.team, a);

    const pinned = await as(w.owner).post(`/v1/threads/${a}/pin`);
    expect(pinned.status, JSON.stringify(pinned.json)).toBe(200);
    expect(pinned.json.pinned_at).toEqual(expect.any(String));
    expect(pinned.json.archived_at).toBeNull();
    expect((await as(w.owner).post(`/v1/threads/${b}/pin`)).status).toBe(200);
    // Pinning again keeps the first pin time (idempotent).
    const again = await as(w.owner).post(`/v1/threads/${a}/pin`);
    expect(again.json.pinned_at).toBe(pinned.json.pinned_at);

    expect(ids(await as(w.owner).get("/v1/threads"))).toEqual([c]);
    expect(ids(await as(w.owner).get("/v1/threads/pinned"))).toEqual([b, a]);
    expect(await activity(w.team, a)).toBe(before);

    const unpinned = await as(w.owner).post(`/v1/threads/${a}/unpin`);
    expect(unpinned.status).toBe(200);
    expect(unpinned.json.pinned_at).toBeNull();
    expect(ids(await as(w.owner).get("/v1/threads/pinned"))).toEqual([b]);
    expect(ids(await as(w.owner).get("/v1/threads")).sort()).toEqual([a, c].sort());
  });

  it("pages the Pinned list with a cursor", async () => {
    const w = await f.world();
    const made = [await f.thread(w.owner), await f.thread(w.owner), await f.thread(w.owner)];
    for (const id of made)
      expect((await as(w.owner).post(`/v1/threads/${id}/pin`)).status).toBe(200);
    const first = await as(w.owner).get("/v1/threads/pinned?limit=2");
    expect(ids(first)).toEqual([made[2], made[1]]);
    const next = await as(w.owner).get(
      `/v1/threads/pinned?limit=2&cursor=${encodeURIComponent(first.json.next_cursor)}`,
    );
    expect(ids(next)).toEqual([made[0]]);
    expect(next.json.next_cursor).toBeNull();
  });
});

describe("archive and unarchive", () => {
  it("hides the thread from the normal list, unpins it, lists it as Archived and restores it", async () => {
    const w = await f.world();
    const a = await f.thread(w.owner);
    const b = await f.thread(w.owner);
    await as(w.owner).post(`/v1/threads/${a}/pin`);
    const before = await activity(w.team, a);

    const archived = await as(w.owner).post(`/v1/threads/${a}/archive`);
    expect(archived.status, JSON.stringify(archived.json)).toBe(200);
    expect(archived.json).toMatchObject({ pinned_at: null, archived_at: expect.any(String) });
    expect(ids(await as(w.owner).get("/v1/threads"))).toEqual([b]);
    expect(ids(await as(w.owner).get("/v1/threads/pinned"))).toEqual([]);
    expect(ids(await as(w.owner).get("/v1/threads/archived"))).toEqual([a]);
    expect(await activity(w.team, a)).toBe(before);
    // The detail still reads, marked.
    expect((await as(w.owner).get(`/v1/threads/${a}`)).json.archived_at).toBe(
      archived.json.archived_at,
    );

    // Pinning needs it out of the archive first.
    const pin = await as(w.owner).post(`/v1/threads/${a}/pin`);
    expect(pin.status).toBe(409);
    expect(pin.json.code).toBe("thread_archived");

    const back = await as(w.owner).post(`/v1/threads/${a}/unarchive`);
    expect(back.status).toBe(200);
    expect(back.json.archived_at).toBeNull();
    expect(ids(await as(w.owner).get("/v1/threads/archived"))).toEqual([]);
    expect(ids(await as(w.owner).get("/v1/threads")).sort()).toEqual([a, b].sort());
  });

  it("keeps archived threads searchable, marked as archived", async () => {
    const w = await f.world();
    const a = await f.thread(w.owner);
    expect((await as(w.owner).patch(`/v1/threads/${a}`, { title: "zephyr budget" })).status).toBe(
      200,
    );
    await as(w.owner).post(`/v1/threads/${a}/archive`);
    const found = await as(w.owner).get("/v1/threads?q=zephyr");
    expect(found.status, JSON.stringify(found.json)).toBe(200);
    expect(found.json.threads).toEqual([
      expect.objectContaining({ thread_id: a, archived_at: expect.any(String), pinned_at: null }),
    ]);
  });
});

describe("who may organize", () => {
  it("is the owner only: another member gets 404; Trash and test threads are refused", async () => {
    const w = await f.world();
    const other = await f.member(w.team);
    const a = await f.thread(w.owner);
    for (const action of ["pin", "unpin", "archive", "unarchive"]) {
      const res = await as(other).post(`/v1/threads/${a}/${action}`);
      expect(res.status, action).toBe(404);
    }
    expect((await as(other).post(`/v1/threads/${a}/move`, { project_id: null })).status).toBe(404);

    expect((await as(w.owner).delete(`/v1/threads/${a}`)).status).toBe(200);
    const trashed = await as(w.owner).post(`/v1/threads/${a}/pin`);
    expect(trashed.status).toBe(409);
    expect(trashed.json.code).toBe("thread_in_trash");
    expect((await as(w.owner).post(`/v1/threads/${a}/archive`)).json.code).toBe("thread_in_trash");
  });

  it("refuses a reader of a thread shared to their project (read-only)", async () => {
    const w = await f.world();
    const reader = await f.member(w.team);
    const projectId = await project(w.owner, "Shared", {
      members_mode: "selected",
      member_user_ids: [reader.id],
    });
    const made = await as(w.owner).post("/v1/threads", { project_id: projectId, title: "x" });
    const id = made.json.thread_id as string;
    expect(
      (await as(w.owner).post(`/v1/threads/${id}/share`, { visibility: "project" })).status,
    ).toBe(200);
    const res = await as(reader).post(`/v1/threads/${id}/pin`);
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("read_only");
    // The owner's pin is their own: the reader's copy of the summary never shows it.
    expect((await as(w.owner).post(`/v1/threads/${id}/pin`)).json.pinned_at).toEqual(
      expect.any(String),
    );
    expect((await as(reader).get(`/v1/threads/${id}`)).json.pinned_at).toBeNull();
  });

  it("rejects malformed ids and bodies", async () => {
    const w = await f.world();
    const a = await f.thread(w.owner);
    expect((await as(w.owner).post(`/v1/threads/not-a-uuid/pin`)).status).toBe(400);
    expect((await as(w.owner).post(`/v1/threads/${a}/move`, {})).status).toBe(400);
    expect((await as(w.owner).post(`/v1/threads/${a}/move`, { project_id: "nope" })).status).toBe(
      400,
    );
    expect((await as(w.owner).get(`/v1/threads/archived?cursor=bad`)).status).toBe(400);
  });
});

describe("move to project", () => {
  it("moves where the member may start a thread, audits it, and is a no-op for the same project", async () => {
    const w = await f.world();
    const a = await f.thread(w.owner);
    const q4 = await project(w.owner, "Q4");

    const moved = await as(w.owner).post(`/v1/threads/${a}/move`, { project_id: q4 });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    expect(moved.json.project_id).toBe(q4);
    expect(ids(await as(w.owner).get(`/v1/threads?project_id=${q4}`))).toEqual([a]);
    const same = await as(w.owner).post(`/v1/threads/${a}/move`, { project_id: q4 });
    expect(same.status).toBe(200);

    const out = await as(w.owner).post(`/v1/threads/${a}/move`, { project_id: null });
    expect(out.status).toBe(200);
    expect(out.json.project_id).toBeNull();
    expect(await audit(w.team, "thread.moved")).toEqual([
      { threadId: a, from: null, to: q4 },
      { threadId: a, from: q4, to: null },
    ]);
  });

  it("is refused where the member cannot create a thread: not a member, archived, unknown", async () => {
    const w = await f.world();
    const member = await f.member(w.team);
    const a = await f.thread(member);
    const closed = await project(w.owner, "Closed", { members_mode: "selected" });
    const old = await project(w.owner, "Old");
    expect((await as(w.owner).patch(`/v1/projects/${old}`, { archived: true })).status).toBe(200);

    for (const target of [closed, old, "00000000-0000-4000-8000-000000000000"]) {
      const res = await as(member).post(`/v1/threads/${a}/move`, { project_id: target });
      expect(res.status, target).toBe(404);
      expect(res.json.code).toBe("project_not_found");
    }
    // The same check as creating a thread there.
    expect((await as(member).post("/v1/threads", { project_id: closed })).status).toBe(404);
    expect((await as(w.owner).get(`/v1/threads/${a}`)).status).toBe(404);
    expect(await audit(w.team, "thread.moved")).toEqual([]);
  });

  it("is refused for another team's project, and another team's member can't move the thread", async () => {
    const w = await f.world();
    const other = await f.world();
    const a = await f.thread(w.owner);
    const theirs = await project(other.owner, "Theirs");
    const res = await as(w.owner).post(`/v1/threads/${a}/move`, { project_id: theirs });
    expect(res.status).toBe(404);
    expect(res.json.code).toBe("project_not_found");
    const outsider = await as(other.owner).post(`/v1/threads/${a}/move`, { project_id: theirs });
    expect(outsider.status).toBe(404);
    expect(outsider.json.code).toBe("thread_not_found");
    expect((await as(w.owner).get(`/v1/threads/${a}`)).json.project_id).toBeNull();
    expect(await audit(w.team, "thread.moved")).toEqual([]);
  });

  it("unshares a thread shared to its old project: the new project's members don't inherit it", async () => {
    const w = await f.world();
    const from = await project(w.owner, "From");
    const to = await project(w.owner, "To");
    const made = await as(w.owner).post("/v1/threads", { project_id: from, title: "x" });
    const id = made.json.thread_id as string;
    await as(w.owner).post(`/v1/threads/${id}/share`, { visibility: "project" });

    const moved = await as(w.owner).post(`/v1/threads/${id}/move`, { project_id: to });
    expect(moved.json).toMatchObject({
      project_id: to,
      shared_to_project: false,
      visibility: "private",
    });
    expect((await audit(w.team, "thread.sharing_changed")).at(-1)).toMatchObject({
      threadId: id,
      projectId: from,
      shared: false,
    });
  });

  it("is refused while a run is queued or running, and for a test thread", async () => {
    const w = await f.world();
    const to = await project(w.owner, "Busy");
    const a = await f.thread(w.owner);
    await f.message(w.owner, a, "hello");
    const busy = await as(w.owner).post(`/v1/threads/${a}/move`, { project_id: to });
    expect(busy.status).toBe(409);
    expect(busy.json.code).toBe("thread_busy");

    const { rows } = await f.fx.admin.query<{ id: string }>(
      `INSERT INTO threads (team_id, owner_user_id, is_test) VALUES ($1, $2, true) RETURNING id`,
      [w.team, w.owner.id],
    );
    const test = rows[0]?.id ?? "";
    const refused = await as(w.owner).post(`/v1/threads/${test}/move`, { project_id: to });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("test_thread");
  });

  it("gives the next run the new project's context and marks that run once", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0, ["skill_bundles", "builtin_skills", "projects"]);
    const q3 = await project(w.owner, "Q3", { instructions: "Use Q3 numbers." });
    const q4 = await project(w.owner, "Q4", { instructions: "Use Q4 numbers." });
    const made = await as(w.owner).post("/v1/threads", { project_id: q3, title: "x" });
    const id = made.json.thread_id as string;

    const first = await f.message(w.owner, id, "one");
    const start1 = await ws.started(first);
    expect(start1.project?.id).toBe(q3);
    ws.reply(start1, "a");
    await f.until(w.team, first, "completed");

    // Two moves before the next run: one marker, from where the last run was to where it is now.
    expect((await as(w.owner).post(`/v1/threads/${id}/move`, { project_id: null })).status).toBe(
      200,
    );
    const markersBefore = threadMarkersSchema.parse(
      (await as(w.owner).get(`/v1/threads/${id}/markers`)).json,
    );
    expect(markersBefore.projects).toEqual([]); // no run after the move yet
    expect((await as(w.owner).post(`/v1/threads/${id}/move`, { project_id: q4 })).status).toBe(200);

    const second = await f.message(w.owner, id, "two");
    const start2 = await ws.started(second);
    expect(start2.project).toMatchObject({ id: q4, instructions: "Use Q4 numbers." });
    const entries = ws.reply(start2, "b");
    await f.until(w.team, second, "completed");

    const markers = threadMarkersSchema.parse(
      (await as(w.owner).get(`/v1/threads/${id}/markers`)).json,
    );
    expect(markers.projects).toEqual([
      expect.objectContaining({
        run_id: second,
        user_entry_id: entries.user,
        from_project_id: q3,
        from_project_name: "Q3",
        from_project_hidden: false,
        to_project_id: q4,
        to_project_name: "Q4",
        to_project_hidden: false,
      }),
    ]);

    // Away and back again before a run: nothing changed for the agent, so no marker.
    await as(w.owner).post(`/v1/threads/${id}/move`, { project_id: null });
    await as(w.owner).post(`/v1/threads/${id}/move`, { project_id: q4 });
    const third = await f.message(w.owner, id, "three");
    ws.reply(await ws.started(third), "c");
    await f.until(w.team, third, "completed");
    const after = threadMarkersSchema.parse(
      (await as(w.owner).get(`/v1/threads/${id}/markers`)).json,
    );
    expect(after.projects.map((m) => m.run_id)).toEqual([second]);
  });

  it("bounds project_moves in the database too: an array of at most 20 (review L3)", async () => {
    const w = await f.world();
    const a = await f.thread(w.owner);
    const set = (value: unknown) =>
      f.fx.admin.query(
        `UPDATE threads SET project_moves = $3::jsonb WHERE team_id = $1 AND id = $2`,
        [w.team, a, JSON.stringify(value)],
      );
    await expect(set(Array.from({ length: 20 }, () => ({})))).resolves.toBeDefined();
    await expect(set(Array.from({ length: 21 }, () => ({})))).rejects.toMatchObject({
      code: "23514",
    });
    await expect(set({ at: "x" })).rejects.toMatchObject({ code: "23514" });
  });

  it("names only projects the viewer may open in the marker, and never their ids", async () => {
    const w = await f.world();
    const member = await f.member(w.team);
    const ws = await f.connect(
      { ...w, owner: member, target: { teamId: w.team, userId: member.id } },
      0,
    );
    const open = await project(w.owner, "Open");
    const a = await f.thread(member);
    await as(member).post(`/v1/threads/${a}/move`, { project_id: open });
    // The member then loses the project (it becomes selected-mode without them).
    expect(
      (await as(w.owner).patch(`/v1/projects/${open}`, { members_mode: "selected" })).status,
    ).toBe(200);
    const run = await f.message(member, a, "hi");
    ws.reply(await ws.started(run), "ok");
    await f.until(w.team, run, "completed");
    const markers = threadMarkersSchema.parse(
      (await as(member).get(`/v1/threads/${a}/markers`)).json,
    );
    expect(markers.projects).toEqual([
      expect.objectContaining({
        run_id: run,
        from_project_id: null,
        from_project_hidden: false,
        // A project the viewer can't open: "another project", its id not sent (review L2).
        to_project_id: null,
        to_project_name: null,
        to_project_hidden: true,
      }),
    ]);
  });
});
