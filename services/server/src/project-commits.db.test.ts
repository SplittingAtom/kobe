import { describe, expect, it } from "vitest";
import {
  PREFIX,
  audits,
  detail,
  fx,
  move,
  objects,
  projectUpload,
  remove,
  rows,
  save,
  settle,
  sha,
  treeOf,
  workspaceUpload,
  world,
} from "./testing/project-commits-fixture.js";

/**
 * KOBE-579 (Workspaces WS-4, ac-1) against a real Postgres: checkout, editing through the FE4 save
 * and the Files routes, commit (server-side copy into `blobs/<sha256>`), `commit_conflict`, Update
 * with conflict copies, Discard back to the head, Revert; refusals (no checkout, another member's
 * checkout, mismatched bytes, foreign source) and sources (a file moved between checkouts).
 * Shared world: `testing/project-commits-fixture.ts`.
 */

describe("checkout, edit, commit, conflict, update, discard, revert (ac-1)", () => {
  it("runs the whole cycle with the right trees, diffs and audit rows", async () => {
    const w = await world();
    const { id, slug } = w.project;
    const dir = `projects/${slug}`;
    await projectUpload(w.as.alice, id, "a.md", "A1");
    // Readers read history but never check out.
    expect((await w.as.carol.get(`/v1/projects/${id}/commits`)).status).toBe(200);
    expect((await w.as.carol.post(`/v1/projects/${id}/checkout`, {})).status).toBe(403);

    // Checkout: base = head (commit 1), idempotent; the folder is written in (no thread yet).
    const co = await w.as.alice.post(`/v1/projects/${id}/checkout`, {});
    expect(co.status, JSON.stringify(co.json)).toBe(200);
    expect(co.json).toMatchObject({ project_id: id, slug, base_commit_seq: 1 });
    expect((await w.as.alice.post(`/v1/projects/${id}/checkout`, {})).json).toMatchObject({
      base_commit_seq: 1,
    });
    expect((await rows(w.team, w.people.alice.id, slug)).get("a.md")?.sha256).toBe(sha("A1"));
    expect((await w.as.alice.get("/v1/me/checkouts")).json).toMatchObject({
      checkouts: [{ project_id: id, slug, base_commit_seq: 1 }],
    });

    // Edit through the editor's save (FE4) and a Files upload, both inside the checkout (CM3).
    expect((await save(w.as.alice, `${dir}/a.md`, sha("A1"), "A2")).status).toBe(200);
    expect((await workspaceUpload(w.as.alice, dir, "c.md", "C1")).status).toBe(201);
    // Outside a checkout the folder stays read-only: bob has none yet.
    expect((await save(w.as.bob, `${dir}/a.md`, sha("A1"), "nope")).status).toBe(403);
    const mine = await w.as.alice.get(`/v1/projects/${id}/checkout`);
    expect(mine.json).toMatchObject({
      base_commit_seq: 1,
      diff: [
        { change: "modified", path: "a.md", size_bytes: 2, previous_size_bytes: 2 },
        { change: "added", path: "c.md", size_bytes: 2 },
      ],
    });

    // Commit 2: the tree, the diff, the copy into blobs/<sha256>, project_files, the base.
    const c2 = await w.as.alice.post(`/v1/projects/${id}/commit`, { message: "edit a, add c" });
    expect(c2.status, JSON.stringify(c2.json)).toBe(200);
    expect(c2.json).toMatchObject({ status: "committed", seq: 2 });
    const d2 = await detail(w.as.carol, id, 2);
    expect(treeOf(d2)).toEqual({ "a.md": sha("A2"), "c.md": sha("C1") });
    expect(d2.diff.map((d) => [d.change, d.path])).toEqual([
      ["modified", "a.md"],
      ["added", "c.md"],
    ]);
    const key = d2.tree.find((e) => e.path === "a.md")?.blob_ref;
    expect(key).toBe(`${PREFIX}teams/${w.team}/projects/${id}/blobs/${sha("A2")}`);
    expect(objects.objects.get(key ?? "")?.toString()).toBe("A2");
    const files = await fx.admin.query<{ path: string; sha256: string }>(
      `SELECT path, sha256 FROM project_files WHERE team_id = $1 AND project_id = $2 ORDER BY path`,
      [w.team, id],
    );
    expect(files.rows).toEqual([
      { path: "a.md", sha256: sha("A2") },
      { path: "c.md", sha256: sha("C1") },
    ]);
    expect((await w.as.alice.get(`/v1/projects/${id}/checkout`)).json).toMatchObject({
      base_commit_seq: 2,
      diff: [],
    });
    expect(await w.as.alice.post(`/v1/projects/${id}/commit`, { message: "again" })).toMatchObject({
      status: 200,
      json: { status: "nothing_to_commit" },
    });
    const committed = await audits(w.team, "project.committed");
    expect(committed.at(-1)).toMatchObject({
      projectId: id,
      seq: 2,
      authorKind: "user",
      added: 1,
      modified: 1,
      deleted: 0,
      fileCount: 2,
    });
    expect(JSON.stringify(committed)).not.toContain("a.md");
    // Storage attributed to the project: a.md's first version is history now.
    const counters = await fx.admin.query(
      `SELECT live_objects, history_objects FROM projects WHERE team_id = $1 AND id = $2`,
      [w.team, id],
    );
    expect(counters.rows[0]).toEqual({ live_objects: 2, history_objects: 1 });

    // Bob checks out at 2 and edits a.md; alice commits 3 first (a.md and a new d.md).
    expect((await w.as.bob.post(`/v1/projects/${id}/checkout`, {})).status).toBe(200);
    expect((await save(w.as.bob, `${dir}/a.md`, sha("A2"), "B2")).status).toBe(200);
    expect((await save(w.as.alice, `${dir}/a.md`, sha("A2"), "A3")).status).toBe(200);
    expect((await workspaceUpload(w.as.alice, dir, "d.md", "D1")).status).toBe(201);
    expect(
      (await w.as.alice.post(`/v1/projects/${id}/commit`, { message: "three" })).json,
    ).toMatchObject({ status: "committed", seq: 3 });
    const stale = await w.as.bob.post(`/v1/projects/${id}/commit`, { message: "bob" });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "commit_conflict", head_seq: 3 });

    // Update: d.md (untouched) arrives; a.md takes the head's version, bob's edit is a copy.
    const up = await w.as.bob.post(`/v1/projects/${id}/checkout/update`, {});
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    const update = up.json as { base_commit_seq: number; conflict_paths: string[] };
    expect(update.base_commit_seq).toBe(3);
    expect(update.conflict_paths).toHaveLength(1);
    const copy = update.conflict_paths[0] ?? "";
    expect(copy).toMatch(new RegExp(`^${dir}/a\\.conflict-\\d{8}T\\d{6}Z\\.md$`));
    const bobRows = await rows(w.team, w.people.bob.id, slug);
    expect(bobRows.get("a.md")?.sha256).toBe(sha("A3"));
    expect(bobRows.get("d.md")).toMatchObject({ sha256: sha("D1"), origin: "server" });
    expect(bobRows.get(copy.slice(dir.length + 1))?.sha256).toBe(sha("B2"));
    // A conflict copy is refused by name until it is resolved; then nothing is left to commit.
    const refusedCopy = await w.as.bob.post(`/v1/projects/${id}/commit`, { message: "x" });
    expect(refusedCopy.status).toBe(422);
    expect(String((refusedCopy.json as { message: string }).message)).toContain(".conflict-");
    const q = new URLSearchParams({ path: copy });
    expect((await w.as.bob.request("DELETE", `/v1/workspace/files?${q.toString()}`)).status).toBe(
      204,
    );
    expect((await w.as.bob.post(`/v1/projects/${id}/commit`, { message: "x" })).json).toMatchObject(
      { status: "nothing_to_commit" },
    );

    // Discard restores the head (alice keeps the project open with a conversation).
    expect((await w.as.alice.post("/v1/threads", { project_id: id })).status).toBe(201);
    expect((await save(w.as.alice, `${dir}/a.md`, sha("A3"), "junk")).status).toBe(200);
    expect((await workspaceUpload(w.as.alice, dir, "new.md", "N")).status).toBe(201);
    expect((await w.as.alice.request("DELETE", `/v1/projects/${id}/checkout`)).status).toBe(204);
    const after = await rows(w.team, w.people.alice.id, slug);
    expect(Object.fromEntries([...after].map(([p, e]) => [p, [e.sha256, e.origin]]))).toEqual({
      "a.md": [sha("A3"), "server"],
      "c.md": [sha("C1"), "server"],
      "d.md": [sha("D1"), "server"],
    });
    expect((await w.as.alice.get(`/v1/projects/${id}/checkout`)).status).toBe(404);
    expect((await save(w.as.alice, `${dir}/a.md`, sha("A3"), "x")).status).toBe(403);
    expect(await audits(w.team, "project.checkout_discarded")).toEqual([
      { projectId: id, userId: w.people.alice.id, reason: "discarded" },
    ]);

    // Revert to 1: a new commit whose tree is the tree at 1; history only grows.
    const rev = await w.as.alice.post(`/v1/projects/${id}/commits/1/revert`, {});
    expect(rev.json).toMatchObject({ status: "committed", seq: 4 });
    expect(treeOf(await detail(w.as.alice, id, 4))).toEqual(
      treeOf(await detail(w.as.alice, id, 1)),
    );
    expect(await audits(w.team, "project.commit_reverted")).toEqual([
      { projectId: id, commitId: expect.any(String), seq: 4, revertedSeq: 1 },
    ]);
    const history = await w.as.carol.get(`/v1/projects/${id}/commits?limit=2`);
    expect(history.json).toMatchObject({ next_before: 3 });
    expect((history.json as { commits: { seq: number }[] }).commits.map((c) => c.seq)).toEqual([
      4, 3,
    ]);
    // The mount follows the head in the background (alice's thread keeps it open).
    await settle();
    expect((await rows(w.team, w.people.alice.id, slug)).get("a.md")?.sha256).toBe(sha("A1"));
    // A file at a commit, and the head as a zip.
    const old = await w.as.carol.get(`/v1/projects/${id}/commits/2/files/c.md`);
    expect(old.status).toBe(200);
    expect(old.text).toBe("C1");
    const zip = await w.as.carol.get(`/v1/projects/${id}/download`);
    expect(zip.status).toBe(200);
  });

  it("answers 404 to a non-member of a restricted project", async () => {
    const w = await world();
    const { id } = w.project;
    expect(
      (await w.as.alice.request("PATCH", `/v1/projects/${id}`, { visibility: "restricted" }))
        .status,
    ).toBe(200);
    for (const path of ["commits", "commits/1", "checkout", "download"]) {
      expect((await w.as.carol.get(`/v1/projects/${id}/${path}`)).status).toBe(404);
    }
    expect((await w.as.carol.post(`/v1/projects/${id}/checkout`, {})).status).toBe(404);
  });
});

describe("refusals and sources (ac-1)", () => {
  it("refuses writes into a project folder without a checkout and into another member's checkout", async () => {
    const w = await world();
    const { id, slug } = w.project;
    const dir = `projects/${slug}`;
    await projectUpload(w.as.alice, id, "a.md", "A1");
    expect((await w.as.alice.post(`/v1/projects/${id}/checkout`, {})).status).toBe(200);
    // bob has a conversation (mounted, read-only) but no checkout; alice's checkout is hers.
    expect((await w.as.bob.post("/v1/threads", { project_id: id })).status).toBe(201);
    expect((await save(w.as.bob, `${dir}/a.md`, sha("A1"), "x")).status).toBe(403);
    expect((await workspaceUpload(w.as.bob, dir, "n.md", "n")).status).toBe(403);
    expect((await move(w.as.bob, `${dir}/a.md`, "a.md")).status).toBe(403);
    expect((await remove(w.as.bob, `${dir}/a.md`)).status).toBe(403);
    // alice inside her own checkout: all allowed.
    expect((await workspaceUpload(w.as.alice, dir, "n.md", "n")).status).toBe(201);
    expect((await move(w.as.alice, `${dir}/n.md`, `${dir}/m.md`)).status).toBe(200);
    expect((await remove(w.as.alice, `${dir}/m.md`)).status).toBe(204);
  });

  it("refuses a copy whose bytes do not match, and a source outside the member's reach", async () => {
    const w = await world();
    const { id, slug } = w.project;
    await projectUpload(w.as.alice, id, "a.md", "A1");
    expect((await w.as.alice.post(`/v1/projects/${id}/checkout`, {})).status).toBe(200);
    expect((await save(w.as.alice, `projects/${slug}/a.md`, sha("A1"), "A2")).status).toBe(200);
    const src = `${PREFIX}teams/${w.team}/users/${w.people.alice.id}/workspace/${sha("A2")}`;
    const good = objects.objects.get(src);
    objects.objects.set(src, Buffer.from("tampered"));
    const bad = await w.as.alice.post(`/v1/projects/${id}/commit`, { message: "x" });
    expect(bad.status).toBe(503);
    expect(objects.objects.has(`${PREFIX}teams/${w.team}/projects/${id}/blobs/${sha("A2")}`)).toBe(
      false,
    );
    objects.objects.set(src, good ?? Buffer.from("A2"));
    // A row naming another member's object (never written by the server this way) is refused.
    const foreign = `${PREFIX}teams/${w.team}/users/${w.people.bob.id}/workspace/${sha("A2")}`;
    objects.objects.set(foreign, Buffer.from("A2"));
    await fx.admin.query(
      `UPDATE workspace_files SET blob_key = $3 WHERE team_id = $1 AND user_id = $2 AND path = $4`,
      [w.team, w.people.alice.id, foreign, `projects/${slug}/a.md`],
    );
    expect((await w.as.alice.post(`/v1/projects/${id}/commit`, { message: "x" })).status).toBe(503);
    await fx.admin.query(
      `UPDATE workspace_files SET blob_key = $3 WHERE team_id = $1 AND user_id = $2 AND path = $4`,
      [w.team, w.people.alice.id, src, `projects/${slug}/a.md`],
    );
    expect(
      (await w.as.alice.post(`/v1/projects/${id}/commit`, { message: "x" })).json,
    ).toMatchObject({ status: "committed", seq: 2 });
    // The committed row now names the project's copy (not stored and counted twice).
    expect((await rows(w.team, w.people.alice.id, slug)).get("a.md")?.blobKey).toBe(
      `${PREFIX}teams/${w.team}/projects/${id}/blobs/${sha("A2")}`,
    );
  });

  it("commits a file moved in from another checked-out project (its object, verified)", async () => {
    const w = await world();
    const { id, slug } = w.project;
    await projectUpload(w.as.alice, id, "a.md", "A1");
    const other = await w.as.alice.post("/v1/projects", { name: "Other" });
    expect(other.status).toBe(201);
    const q = other.json as { id: string; slug: string };
    await projectUpload(w.as.alice, q.id, "x.md", "X1");
    expect((await w.as.alice.post(`/v1/projects/${id}/checkout`, {})).status).toBe(200);
    expect((await w.as.alice.post(`/v1/projects/${q.id}/checkout`, {})).status).toBe(200);
    expect(
      (await move(w.as.alice, `projects/${q.slug}/x.md`, `projects/${slug}/x.md`)).status,
    ).toBe(200);
    expect(
      (await w.as.alice.post(`/v1/projects/${id}/commit`, { message: "moved in" })).json,
    ).toMatchObject({ status: "committed", seq: 2 });
    const d = await detail(w.as.alice, id, 2);
    expect(treeOf(d)).toEqual({ "a.md": sha("A1"), "x.md": sha("X1") });
    expect(
      objects.objects.get(`${PREFIX}teams/${w.team}/projects/${id}/blobs/${sha("X1")}`)?.toString(),
    ).toBe("X1");
  });

  it("refuses a conflict copy only where the commit adds or changes it", async () => {
    const w = await world();
    const { id, slug } = w.project;
    // An upload with such a name is in the head already (refused nowhere else).
    await projectUpload(w.as.alice, id, "a.conflict-20260101T000000Z.md", "old");
    await projectUpload(w.as.alice, id, "b.md", "B1");
    expect((await w.as.alice.post(`/v1/projects/${id}/checkout`, {})).status).toBe(200);
    expect((await save(w.as.alice, `projects/${slug}/b.md`, sha("B1"), "B2")).status).toBe(200);
    expect(
      (await w.as.alice.post(`/v1/projects/${id}/commit`, { message: "b" })).json,
    ).toMatchObject({ status: "committed" });
  });
});
