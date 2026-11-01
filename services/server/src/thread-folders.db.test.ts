import { randomUUID } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportZip } from "./retention/export.js";
import { RunFixture } from "./testing/run-fixture.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * Thread folders (KOBE-534, spec TF1-TF11): the team's folders, which any member creates,
 * renames, moves and deletes (audited with the actor); filing by the owner or a reader of the
 * thread; the `folder` filter of the thread list and of `/pinned` with per-viewer counts; forks,
 * Trash and archive keep the folder; the export names the folder path.
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

async function audit(team: string, action: string) {
  const { rows } = await f.fx.admin.query<{ actor: string; target: Record<string, unknown> }>(
    `SELECT actor_id AS actor, target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
    [team, action],
  );
  return rows;
}

async function folder(p: Person, name: string, parentId?: string): Promise<string> {
  const res = await as(p).post("/v1/thread-folders", {
    name,
    ...(parentId ? { parent_id: parentId } : {}),
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.id as string;
}

async function file(p: Person, threadId: string, folderId: string | null) {
  return as(p).post(`/v1/threads/${threadId}/file`, { folder_id: folderId });
}

async function row(team: string, threadId: string) {
  const { rows } = await f.fx.admin.query<{
    folder_id: string | null;
    activity: string;
    pinned: boolean;
    archived: boolean;
    project_id: string | null;
    shared_to_team: boolean;
  }>(
    `SELECT folder_id, last_activity_at::text AS activity, pinned_at IS NOT NULL AS pinned,
            archived_at IS NOT NULL AS archived, project_id, shared_to_team
       FROM threads WHERE team_id = $1 AND id = $2`,
    [team, threadId],
  );
  return rows[0];
}

async function shareToTeam(p: Person, threadId: string) {
  const res = await as(p).post(`/v1/threads/${threadId}/share`, { visibility: "team" });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

async function counts(p: Person): Promise<Record<string, number>> {
  const res = await as(p).get("/v1/thread-folders");
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return Object.fromEntries(
    (res.json.folders as { id: string; threads: number }[]).map((x) => [x.id, x.threads]),
  );
}

describe("folders (ac-1)", () => {
  it("any member creates, renames, moves and deletes folders, each audited with its actor", async () => {
    const w = await f.world(1);
    const member = w.others[0] as Person;
    const top = await folder(w.owner, "Budget");
    const sub = await folder(member, "2027", top);

    const list = await as(member).get("/v1/thread-folders");
    expect(list.json.folders).toEqual([
      { id: top, parent_id: null, name: "Budget", position: 0, created_by: w.owner.id, threads: 0 },
      { id: sub, parent_id: top, name: "2027", position: 0, created_by: member.id, threads: 0 },
    ]);

    const renamed = await as(member).patch(`/v1/thread-folders/${top}`, { name: "Finance" });
    expect(renamed.status, JSON.stringify(renamed.json)).toBe(200);
    expect(renamed.json).toMatchObject({ id: top, name: "Finance" });
    const moved = await as(w.owner).patch(`/v1/thread-folders/${sub}`, { parent_id: null });
    expect(moved.json).toMatchObject({ id: sub, parent_id: null });
    // A position change alone is not audited; the same name again is no change.
    expect(
      (await as(w.owner).patch(`/v1/thread-folders/${sub}`, { position: 4 })).json.position,
    ).toBe(4);
    expect((await as(w.owner).patch(`/v1/thread-folders/${top}`, { name: "Finance" })).status).toBe(
      200,
    );
    expect((await as(member).delete(`/v1/thread-folders/${sub}`)).status).toBe(204);

    expect(await audit(w.team, "thread_folder.created")).toEqual([
      { actor: w.owner.id, target: { folderId: top, name: "Budget", parentId: null } },
      { actor: member.id, target: { folderId: sub, name: "2027", parentId: top } },
    ]);
    expect(await audit(w.team, "thread_folder.renamed")).toEqual([
      { actor: member.id, target: { folderId: top, from: "Budget", to: "Finance" } },
    ]);
    expect(await audit(w.team, "thread_folder.moved")).toEqual([
      { actor: w.owner.id, target: { folderId: sub, from: top, to: null } },
    ]);
    expect(await audit(w.team, "thread_folder.deleted")).toEqual([
      { actor: member.id, target: { folderId: sub, name: "2027", folders: 0, threads: 0 } },
    ]);
  });

  it("answers the stated errors, and a refused change leaves no row and no audit", async () => {
    const w = await f.world();
    const other = await f.world();
    const a = await folder(w.owner, "A");
    const b = await folder(w.owner, "B", a);
    const c = await folder(w.owner, "C", b);
    const x = await folder(w.owner, "X");
    const y = await folder(w.owner, "Y", x);
    const theirs = await folder(other.owner, "Theirs");
    const code = async (res: Promise<{ status: number; json: { code?: string } }>) => {
      const r = await res;
      return [r.status, r.json.code];
    };

    expect(await code(as(w.owner).post("/v1/thread-folders", { name: "a" }))).toEqual([
      409,
      "folder_name_taken",
    ]);
    expect(await code(as(w.owner).post("/v1/thread-folders", { name: "D", parent_id: c }))).toEqual(
      [409, "folder_too_deep"],
    );
    expect(
      await code(as(w.owner).post("/v1/thread-folders", { name: "D", parent_id: theirs })),
    ).toEqual([404, "folder_not_found"]);
    expect(await code(as(w.owner).patch(`/v1/thread-folders/${a}`, { parent_id: c }))).toEqual([
      409,
      "folder_cycle",
    ]);
    expect(await code(as(w.owner).patch(`/v1/thread-folders/${a}`, { parent_id: a }))).toEqual([
      409,
      "folder_cycle",
    ]);
    // B takes C along: under Y (level 2) C would be at level 4.
    expect(await code(as(w.owner).patch(`/v1/thread-folders/${b}`, { parent_id: y }))).toEqual([
      409,
      "folder_too_deep",
    ]);
    expect(await code(as(w.owner).patch(`/v1/thread-folders/${b}`, { name: "X" }))).toEqual([
      200,
      undefined,
    ]);
    expect(await code(as(w.owner).patch(`/v1/thread-folders/${y}`, { parent_id: null }))).toEqual([
      200,
      undefined,
    ]);
    expect(await code(as(w.owner).patch(`/v1/thread-folders/${y}`, { name: "x" }))).toEqual([
      409,
      "folder_name_taken",
    ]);
    for (const res of [
      as(w.owner).patch(`/v1/thread-folders/${theirs}`, { name: "Mine" }),
      as(w.owner).delete(`/v1/thread-folders/${theirs}`),
      as(w.owner).patch(`/v1/thread-folders/${randomUUID()}`, { name: "Z" }),
    ]) {
      expect(await code(res)).toEqual([404, "folder_not_found"]);
    }
    for (const bad of [{}, { name: "" }, { name: "x".repeat(81) }, { name: "a\nb" }]) {
      expect((await as(w.owner).post("/v1/thread-folders", bad)).status).toBe(400);
    }
    expect((await as(w.owner).patch(`/v1/thread-folders/${a}`, {})).status).toBe(400);
    expect((await as(w.owner).delete(`/v1/thread-folders/nope`)).status).toBe(400);

    expect((await audit(w.team, "thread_folder.created")).length).toBe(5);
    expect((await audit(w.team, "thread_folder.moved")).map((r) => r.target)).toEqual([
      { folderId: y, from: x, to: null },
    ]);
    // Names are trimmed.
    const trimmed = await as(w.owner).post("/v1/thread-folders", { name: "  Plans  " });
    expect(trimmed.json.name).toBe("Plans");
  });

  it("refuses the 501st folder of a team", async () => {
    const w = await f.world();
    await f.fx.admin.query(
      `INSERT INTO thread_folders (team_id, name, created_by)
       SELECT $1, 'f' || g, $2 FROM generate_series(1, 499) g`,
      [w.team, w.owner.id],
    );
    expect((await as(w.owner).post("/v1/thread-folders", { name: "last" })).status).toBe(201);
    const over = await as(w.owner).post("/v1/thread-folders", { name: "one more" });
    expect(over.status).toBe(409);
    expect(over.json.code).toBe("folder_limit");
    expect((await as(w.owner).get("/v1/thread-folders")).json.folders).toHaveLength(500);
  });
});

describe("filing (ac-2)", () => {
  it("files by the owner, idempotent, keeping pin, project and shares; null unfiles", async () => {
    const w = await f.world();
    const project = await as(w.owner).post("/v1/projects", { name: "Q4" });
    const made = await as(w.owner).post("/v1/threads", { project_id: project.json.id, title: "x" });
    const t = made.json.thread_id as string;
    await shareToTeam(w.owner, t);
    await as(w.owner).post(`/v1/threads/${t}/pin`);
    const a = await folder(w.owner, "A");
    const before = await row(w.team, t);

    const filed = await file(w.owner, t, a);
    expect(filed.status, JSON.stringify(filed.json)).toBe(200);
    expect(filed.json).toMatchObject({
      folder_id: a,
      visibility: "team",
      pinned_at: expect.any(String),
    });
    expect((await file(w.owner, t, a)).status).toBe(200);
    expect(await row(w.team, t)).toEqual({ ...before, folder_id: a });
    expect((await as(w.owner).get(`/v1/threads/${t}`)).json.folder_id).toBe(a);

    const out = await file(w.owner, t, null);
    expect(out.json.folder_id).toBeNull();
    expect((await file(w.owner, t, null)).status).toBe(200);
    expect((await audit(w.team, "thread.filed")).map((r) => r.target)).toEqual([
      { threadId: t, from: null, to: a },
      { threadId: t, from: a, to: null },
    ]);
  });

  it("files by a reader of a shared thread, who sees the folder; a stranger gets 404", async () => {
    const w = await f.world(2);
    const reader = w.others[0] as Person;
    const stranger = w.others[1] as Person;
    const shared = await f.thread(w.owner);
    await shareToTeam(w.owner, shared);
    const priv = await f.thread(w.owner);
    const a = await folder(reader, "Reader's");

    const res = await file(reader, shared, a);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ folder_id: a, read_only: true });
    expect((await as(w.owner).get(`/v1/threads/${shared}`)).json.folder_id).toBe(a);
    expect(await audit(w.team, "thread.filed")).toEqual([
      { actor: reader.id, target: { threadId: shared, from: null, to: a } },
    ]);

    const denied = await file(stranger, priv, a);
    expect(denied.status).toBe(404);
    expect(denied.json.code).toBe("thread_not_found");
    // A reader still changes nothing else.
    expect((await as(reader).post(`/v1/threads/${shared}/pin`)).status).toBe(403);
  });

  it("is refused in Trash, on test threads and for a folder of another team", async () => {
    const w = await f.world(1);
    const reader = w.others[0] as Person;
    const other = await f.world();
    const a = await folder(w.owner, "A");
    const theirs = await folder(other.owner, "Theirs");
    const t = await f.thread(w.owner);
    await shareToTeam(w.owner, t);

    for (const target of [theirs, randomUUID()]) {
      const res = await file(w.owner, t, target);
      expect(res.status).toBe(404);
      expect(res.json.code).toBe("folder_not_found");
    }
    // Another team's member cannot reach the thread at all.
    expect((await file(other.owner, t, theirs)).json.code).toBe("thread_not_found");

    expect((await as(w.owner).delete(`/v1/threads/${t}`)).status).toBe(200);
    const trashed = await file(w.owner, t, a);
    expect(trashed.status).toBe(409);
    expect(trashed.json.code).toBe("thread_in_trash");
    expect((await file(reader, t, a)).status).toBe(404);

    for (const marker of ["is_test", "skill_test"]) {
      const test = randomUUID();
      await f.fx.admin.query(
        `INSERT INTO threads (team_id, id, owner_user_id, title, ${marker})
         VALUES ($1, $2, $3, 'test', true)`,
        [w.team, test, w.owner.id],
      );
      const res = await file(w.owner, test, a);
      expect(res.status, marker).toBe(409);
      expect(res.json.code).toBe("test_thread");
    }
    expect((await file(w.owner, "nope", a)).status).toBe(400);
    expect((await as(w.owner).post(`/v1/threads/${t}/file`, {})).status).toBe(400);
    expect(await audit(w.team, "thread.filed")).toEqual([]);
  });
});

const AT = "2026-10-14T10:00:00.000Z";
const message = (id: string, parent: string | null, role: "user" | "assistant", text: string) => ({
  type: "message",
  id,
  parentId: parent,
  timestamp: AT,
  message:
    role === "user"
      ? { role, content: text }
      : {
          role,
          content: [{ type: "text", text }],
          usage: { input: 9, output: 1, totalTokens: 10 },
        },
});

describe("delete, Trash, archive and forks (ac-3)", () => {
  it("deleting a folder cascades to its subfolders and returns their threads to no folder", async () => {
    const w = await f.world(1);
    const member = w.others[0] as Person;
    const top = await folder(w.owner, "Top");
    const sub = await folder(w.owner, "Sub", top);
    const t1 = await f.thread(w.owner);
    const t2 = await f.thread(member);
    expect((await file(w.owner, t1, top)).status).toBe(200);
    expect((await file(member, t2, sub)).status).toBe(200);

    expect((await as(member).delete(`/v1/thread-folders/${top}`)).status).toBe(204);
    expect((await as(w.owner).get("/v1/thread-folders")).json.folders).toEqual([]);
    expect((await row(w.team, t1))?.folder_id).toBeNull();
    expect((await row(w.team, t2))?.folder_id).toBeNull();
    expect(await audit(w.team, "thread_folder.deleted")).toEqual([
      { actor: member.id, target: { folderId: top, name: "Top", folders: 1, threads: 2 } },
    ]);
    expect((await as(w.owner).delete(`/v1/thread-folders/${top}`)).status).toBe(404);
  });

  it("keeps the folder through Trash and archive: Restore and Unarchive return there", async () => {
    const w = await f.world();
    const a = await folder(w.owner, "A");
    const t = await f.thread(w.owner);
    await file(w.owner, t, a);
    expect((await as(w.owner).delete(`/v1/threads/${t}`)).json.folder_id).toBe(a);
    expect((await as(w.owner).post(`/v1/threads/${t}/restore`)).json.folder_id).toBe(a);
    expect((await as(w.owner).post(`/v1/threads/${t}/archive`)).json.folder_id).toBe(a);
    expect(ids(await as(w.owner).get(`/v1/threads?folder=${a}`))).toEqual([]);
    expect(ids(await as(w.owner).get("/v1/threads/archived"))).toEqual([t]);
    expect((await as(w.owner).post(`/v1/threads/${t}/unarchive`)).json.folder_id).toBe(a);
    expect(ids(await as(w.owner).get(`/v1/threads?folder=${a}`))).toEqual([t]);
  });

  it("a fork starts in its source's folder, whoever owns the source", async () => {
    const w = await f.world(1);
    const reader = w.others[0] as Person;
    const a = await folder(w.owner, "A");
    const t = await f.thread(w.owner);
    for (const [id, parent, role, text] of [
      ["u1", null, "user", "question"],
      ["a1", "u1", "assistant", "answer"],
    ] as const) {
      await f.fx.admin.query(
        `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
         VALUES ($1, $2, $3, $4, 'message', $5)`,
        [w.team, t, id, parent, message(id, parent, role, text)],
      );
    }
    await f.fx.admin.query(
      `UPDATE threads SET leaf_entry_id = 'a1' WHERE team_id = $1 AND id = $2`,
      [w.team, t],
    );
    await shareToTeam(w.owner, t);
    await file(w.owner, t, a);

    const fork = await as(reader).post(`/v1/threads/${t}/fork`, {});
    expect(fork.status, JSON.stringify(fork.json)).toBe(201);
    const forked = await as(reader).get(`/v1/threads/${fork.json.thread_id}`);
    expect(forked.json).toMatchObject({ folder_id: a, owner_user_id: reader.id });
    // Unfiled source: unfiled fork.
    await file(w.owner, t, null);
    const again = await as(w.owner).post(`/v1/threads/${t}/fork`, {});
    expect(
      (await as(w.owner).get(`/v1/threads/${again.json.thread_id}`)).json.folder_id,
    ).toBeNull();
  });
});

describe("listing a folder (ac-4)", () => {
  it("lists the caller's own threads of the folder plus others' shared with them, with matching counts", async () => {
    const w = await f.world(1);
    const member = w.others[0] as Person;
    const a = await folder(w.owner, "A");
    const b = await folder(w.owner, "B");
    const own1 = await f.thread(w.owner);
    const ownPinned = await f.thread(w.owner);
    const ownArchived = await f.thread(w.owner);
    const unfiled = await f.thread(w.owner);
    const memberShared = await f.thread(member);
    const memberPrivate = await f.thread(member);
    const inB = await f.thread(w.owner);
    await shareToTeam(member, memberShared);
    for (const t of [own1, ownPinned, ownArchived]) await file(w.owner, t, a);
    await file(member, memberShared, a);
    await file(member, memberPrivate, a);
    await file(w.owner, inB, b);
    await as(w.owner).post(`/v1/threads/${ownPinned}/pin`);
    await as(w.owner).post(`/v1/threads/${ownArchived}/archive`);

    // Newest activity first; the owner's pinned one is in /pinned?folder=, the archived one
    // only under Archived; another member's private filed thread never appears.
    expect(ids(await as(w.owner).get(`/v1/threads?folder=${a}`))).toEqual([memberShared, own1]);
    expect(ids(await as(w.owner).get(`/v1/threads/pinned?folder=${a}`))).toEqual([ownPinned]);
    expect(ids(await as(w.owner).get(`/v1/threads/pinned?folder=${b}`))).toEqual([]);
    expect(await counts(w.owner)).toEqual({ [a]: 3, [b]: 1 });

    expect(ids(await as(member).get(`/v1/threads?folder=${a}`))).toEqual([
      memberPrivate,
      memberShared,
    ]);
    expect(await counts(member)).toEqual({ [a]: 2, [b]: 0 });

    // none: the caller's own unfiled threads only.
    expect(ids(await as(w.owner).get("/v1/threads?folder=none"))).toEqual([unfiled]);
    expect(ids(await as(member).get("/v1/threads?folder=none"))).toEqual([]);
    // The default list is unchanged: every own live thread not pinned or archived.
    expect(ids(await as(w.owner).get("/v1/threads")).sort()).toEqual([own1, unfiled, inB].sort());

    // Unsharing takes it out of the reader's view; the folder stays on the thread.
    await as(member).post(`/v1/threads/${memberShared}/share`, { visibility: "private" });
    expect(ids(await as(w.owner).get(`/v1/threads?folder=${a}`))).toEqual([own1]);
    expect(await counts(w.owner)).toEqual({ [a]: 2, [b]: 1 });
    expect((await row(w.team, memberShared))?.folder_id).toBe(a);
  });

  it("pages ?folder= and /pinned?folder= with a cursor; refuses bad combinations", async () => {
    const w = await f.world();
    const a = await folder(w.owner, "A");
    const made: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const t = await f.thread(w.owner);
      await file(w.owner, t, a);
      made.push(t);
    }
    const pinned: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const t = await f.thread(w.owner);
      await as(w.owner).post(`/v1/threads/${t}/pin`);
      pinned.push(t);
    }
    const first = await as(w.owner).get(`/v1/threads?folder=${a}&limit=2`);
    expect(ids(first)).toEqual([made[2], made[1]]);
    const next = await as(w.owner).get(
      `/v1/threads?folder=${a}&limit=2&cursor=${encodeURIComponent(first.json.next_cursor)}`,
    );
    expect(ids(next)).toEqual([made[0]]);
    expect(next.json.next_cursor).toBeNull();

    const p1 = await as(w.owner).get("/v1/threads/pinned?folder=none&limit=2");
    expect(ids(p1)).toEqual([pinned[2], pinned[1]]);
    const p2 = await as(w.owner).get(
      `/v1/threads/pinned?folder=none&limit=2&cursor=${encodeURIComponent(p1.json.next_cursor)}`,
    );
    expect(ids(p2)).toEqual([pinned[0]]);

    for (const path of [
      `/v1/threads?folder=${a}&q=x`,
      `/v1/threads?folder=nope`,
      `/v1/threads/archived?folder=${a}`,
      `/v1/threads/shared?folder=${a}`,
    ]) {
      expect((await as(w.owner).get(path)).status, path).toBe(400);
    }
    // Search finds filed threads and says where they are.
    await as(w.owner).patch(`/v1/threads/${made[0]}`, { title: "zephyr plan" });
    const found = await as(w.owner).get("/v1/threads?q=zephyr");
    expect(found.json.threads).toEqual([
      expect.objectContaining({ thread_id: made[0], folder_id: a }),
    ]);
  });
});

describe("teams never cross (ac-5)", () => {
  it("another team sees none of the folders, counts or filed threads", async () => {
    const w = await f.world();
    const other = await f.world();
    const a = await folder(w.owner, "A");
    const t = await f.thread(w.owner);
    await shareToTeam(w.owner, t);
    await file(w.owner, t, a);
    expect((await as(other.owner).get("/v1/thread-folders")).json.folders).toEqual([]);
    expect(ids(await as(other.owner).get(`/v1/threads?folder=${a}`))).toEqual([]);
    expect((await as(other.owner).delete(`/v1/thread-folders/${a}`)).status).toBe(404);
    expect(await counts(w.owner)).toEqual({ [a]: 1 });
  });
});

describe("export (ac-6)", () => {
  it("names the folder path in the thread index", async () => {
    const w = await f.world();
    const top = await folder(w.owner, "Finance");
    const sub = await folder(w.owner, "2027", top);
    const filed = await f.thread(w.owner);
    const loose = await f.thread(w.owner);
    await file(w.owner, filed, sub);
    const chunks: Uint8Array[] = [];
    for await (const c of exportZip(f.fx.db, { teamId: w.team, userId: w.owner.id }, undefined)) {
      chunks.push(c);
    }
    const zip = unzipSync(Buffer.concat(chunks));
    const index = JSON.parse(strFromU8(zip["threads.json"] ?? new Uint8Array())) as {
      threads: { id: string; folder?: string }[];
    };
    expect(index.threads.find((x) => x.id === filed)?.folder).toBe("Finance/2027");
    expect(index.threads.find((x) => x.id === loose)).not.toHaveProperty("folder");
  });
});
