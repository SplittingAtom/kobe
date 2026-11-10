import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deleteReleasedBlobs } from "./retention/blobs.js";
import { blobRecorder } from "./retention/job.js";
import { pruneProjectHistory } from "./retention/project-history.js";
import {
  PREFIX,
  audits,
  auth,
  exportedNames,
  fx,
  objects,
  projectUpload,
  pull,
  rows,
  save,
  seqs,
  setHold,
  sha,
  world,
} from "./testing/project-commits-fixture.js";

/**
 * KOBE-579: losing `edit` ends a checkout (editor row removed: a reader, KOBE-587; team admin demoted);
 * the export carries the projects the member may read (GV5); history pruning keeps the head,
 * checkout bases and held workspaces, queues released objects for the blob deleter and is
 * audited (ac-4, GV3).
 */

describe("a role change that takes away edit ends the checkout", () => {
  it("discards an editor's checkout when made reader by removing the row (head back, relocked) and audits it", async () => {
    const w = await world();
    const { id, slug } = w.project;
    await projectUpload(w.as.alice, id, "a.md", "A1");
    expect((await w.as.bob.post("/v1/threads", { project_id: id })).status).toBe(201);
    expect((await w.as.bob.post(`/v1/projects/${id}/checkout`, {})).status).toBe(200);
    expect((await save(w.as.bob, `projects/${slug}/a.md`, sha("A1"), "B1")).status).toBe(200);
    const token = auth.issue({ sandboxId: randomUUID(), teamId: w.team, userId: w.people.bob.id });
    expect((await pull(token)).checkouts).toHaveLength(1);
    const demoted = await w.as.alice.request(
      "DELETE",
      `/v1/projects/${id}/members/${w.people.bob.id}`,
    );
    expect(demoted.status, JSON.stringify(demoted.json)).toBe(204);
    expect((await w.as.bob.get(`/v1/projects/${id}/checkout`)).status).toBe(404);
    expect((await pull(token)).checkouts).toEqual([]);
    // His conversation keeps the project mounted: the head is back as a server row.
    expect((await rows(w.team, w.people.bob.id, slug)).get("a.md")).toMatchObject({
      sha256: sha("A1"),
      origin: "server",
    });
    expect(await audits(w.team, "project.checkout_discarded")).toEqual([
      { projectId: id, userId: w.people.bob.id, reason: "access_lost" },
    ]);
  });

  it("discards it when the editor row of a workspace project goes, and unmounts without a thread", async () => {
    const w = await world();
    const { id, slug } = w.project;
    await projectUpload(w.as.alice, id, "a.md", "A1");
    expect((await w.as.bob.post(`/v1/projects/${id}/checkout`, {})).status).toBe(200);
    expect(
      (await w.as.alice.request("DELETE", `/v1/projects/${id}/members/${w.people.bob.id}`)).status,
    ).toBe(204);
    expect((await w.as.bob.get(`/v1/projects/${id}/checkout`)).status).toBe(404);
    expect([...(await rows(w.team, w.people.bob.id, slug)).keys()]).toEqual([]);
    // Alice, the owner, keeps hers through an unrelated change.
    expect((await w.as.alice.post(`/v1/projects/${id}/checkout`, {})).status).toBe(200);
    expect(
      (
        await w.as.alice.post(`/v1/projects/${id}/members`, {
          user_id: w.people.carol.id,
          role: "editor",
        })
      ).status,
    ).toBe(201);
    expect((await w.as.alice.get(`/v1/projects/${id}/checkout`)).status).toBe(200);
  });
});

describe("a team admin's demotion", () => {
  it("ends a checkout they held only as team admin", async () => {
    const w = await world();
    const { id } = w.project;
    await projectUpload(w.as.alice, id, "a.md", "A1");
    expect((await w.as.admin.post(`/v1/projects/${id}/checkout`, {})).status).toBe(200);
    // Another team admin first, then the demotion (the last team admin stays).
    await fx.admin.query(
      `UPDATE team_members SET role = 'team_admin' WHERE team_id = $1 AND user_id = $2`,
      [w.team, w.people.carol.id],
    );
    expect(
      (await w.as.carol.request("PATCH", `/v1/team/members/${w.admin.id}`, { role: "member" }))
        .status,
    ).toBe(200);
    expect((await w.as.admin.get(`/v1/projects/${id}/checkout`)).status).toBe(404);
    expect(await audits(w.team, "project.checkout_discarded")).toEqual([
      { projectId: id, userId: w.admin.id, reason: "access_lost" },
    ]);
  });
});

describe("export (GV5)", () => {
  it("carries every project the member may read: commit list and head files", async () => {
    const w = await world();
    const { id, slug } = w.project;
    await projectUpload(w.as.alice, id, "a.md", "A1");
    const second = await w.as.alice.post("/v1/projects", { name: "Second" });
    expect(second.status).toBe(201);
    const h = second.json as { id: string; slug: string };
    await projectUpload(w.as.alice, h.id, "secret.md", "S");
    // carol, a plain member without rows, reads both (every member reads every project, KOBE-587).
    const carol = await exportedNames(w.team, w.people.carol.id);
    expect(Buffer.from(carol[`projects/${slug}/head/a.md`] ?? []).toString()).toBe("A1");
    const meta = JSON.parse(Buffer.from(carol[`projects/${slug}/commits.json`] ?? []).toString());
    expect(meta).toMatchObject({ id, slug, head_seq: 1, commits: [{ seq: 1 }] });
    expect(Buffer.from(carol[`projects/${h.slug}/head/secret.md`] ?? []).toString()).toBe("S");
    // The team admin reads every project of the workspace.
    const admin = await exportedNames(w.team, w.admin.id);
    expect(Buffer.from(admin[`projects/${h.slug}/head/secret.md`] ?? []).toString()).toBe("S");
  });
});

// ------------------------------------------------------------------ history pruning (ac-4)

describe("history pruning (ac-4, GV3)", () => {
  it("keeps the head, checkout bases and held workspaces; queues released objects; audits", async () => {
    const w = await world();
    const { id } = w.project;
    const f1 = await projectUpload(w.as.alice, id, "f1.md", "one"); // 1
    await projectUpload(w.as.alice, id, "f2.md", "two"); // 2
    expect((await w.as.bob.post(`/v1/projects/${id}/checkout`, {})).status).toBe(200); // base 2
    expect((await w.as.alice.request("DELETE", `/v1/projects/${id}/files/${f1.id}`)).status).toBe(
      204,
    ); // 3
    await projectUpload(w.as.alice, id, "f3.md", "three"); // 4
    await projectUpload(w.as.alice, id, "f4.md", "four"); // 5
    expect(
      (
        await w.as.admin.request("PUT", "/v1/team/storage", {
          history_keep: { mode: "commits", n: 2 },
        })
      ).status,
    ).toBe(200);

    // Held: nothing goes.
    await setHold(w.team, w.admin.id, true);
    expect(await pruneProjectHistory(fx.db, w.team, { maxCommits: 1000 })).toMatchObject({
      commits: 0,
    });
    expect(await seqs(id)).toEqual([1, 2, 3, 4, 5]);
    await setHold(w.team, w.admin.id, false);

    // Newest 2 kept (4, 5) and bob's base (2); f1's object is still named by commit 2.
    const first = await pruneProjectHistory(fx.db, w.team, { maxCommits: 1000 });
    expect(first).toMatchObject({ projects: 1, commits: 2, blobsQueued: 0 });
    expect(await seqs(id)).toEqual([2, 4, 5]);
    // Bob discards: commit 2 goes too, and f1's object (named by no commit any more) is queued.
    expect((await w.as.bob.request("DELETE", `/v1/projects/${id}/checkout`)).status).toBe(204);
    const second = await pruneProjectHistory(fx.db, w.team, { maxCommits: 1000 });
    expect(second).toMatchObject({ commits: 1, blobsQueued: 1 });
    expect(await seqs(id)).toEqual([4, 5]);
    const queued = await fx.admin.query<{ key: string; thread_id: string }>(
      `SELECT key, thread_id FROM retention_blob_deletions WHERE team_id = $1`,
      [w.team],
    );
    expect(queued.rows).toEqual([
      { key: `${PREFIX}teams/${w.team}/projects/${id}/files/${f1.id}`, thread_id: id },
    ]);
    // The blob deleter takes it once due (nothing names it; no hold); the head's objects stay.
    const f1Key = `${PREFIX}teams/${w.team}/projects/${id}/files/${f1.id}`;
    expect(objects.objects.has(f1Key)).toBe(true);
    await fx.admin.query(
      `UPDATE retention_blob_deletions SET enqueued_at = now() - interval '1 minute' WHERE team_id = $1`,
      [w.team],
    );
    const swept = await deleteReleasedBlobs(
      fx.db,
      w.team,
      { objects, prefix: PREFIX },
      blobRecorder(w.team),
    );
    expect(swept).toEqual({ blobs: 1, kept: 0 });
    expect(objects.objects.has(f1Key)).toBe(false);
    const pruned = await audits(w.team, "project.history_pruned");
    expect(pruned).toEqual([
      { projectId: id, commits: 2, treeEntries: 2, blobsQueued: 0, rule: "commits" },
      { projectId: id, commits: 1, treeEntries: 2, blobsQueued: 1, rule: "commits" },
    ]);
    // The counters follow: f1's object is no longer the project's.
    const counters = await fx.admin.query(
      `SELECT live_objects, history_objects FROM projects WHERE id = $1`,
      [id],
    );
    expect(counters.rows[0]).toEqual({ live_objects: 3, history_objects: 0 });
  });

  it("never deletes a queued project object a workspace row still names", async () => {
    const w = await world();
    const { id } = w.project;
    const f = await projectUpload(w.as.alice, id, "keep.md", "kept");
    const key = `${PREFIX}teams/${w.team}/projects/${id}/files/${f.id}`;
    // alice has it open (a conversation), so her mount names the object.
    expect((await w.as.alice.post("/v1/threads", { project_id: id })).status).toBe(201);
    await fx.admin.query(
      `INSERT INTO retention_blob_deletions (team_id, key, thread_id, owner_user_id, enqueued_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 minute')`,
      [w.team, key, id, w.people.alice.id],
    );
    // Another project's id never reaches this project's objects either.
    await fx.admin.query(
      `INSERT INTO retention_blob_deletions (team_id, key, thread_id, owner_user_id, enqueued_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 minute')`,
      [w.team, `${key}-other`, randomUUID(), w.people.alice.id],
    );
    objects.objects.set(`${key}-other`, Buffer.from("x"));
    const swept = await deleteReleasedBlobs(
      fx.db,
      w.team,
      { objects, prefix: PREFIX },
      blobRecorder(w.team),
    );
    expect(swept).toEqual({ blobs: 0, kept: 2 });
    expect(objects.objects.has(key)).toBe(true);
    expect(objects.objects.has(`${key}-other`)).toBe(true);
  });

  it("prunes by days and by the hard cap", async () => {
    const w = await world();
    const { id } = w.project;
    for (const n of [1, 2, 3, 4]) await projectUpload(w.as.alice, id, `f${n}.md`, `v${n}`);
    expect(
      (
        await w.as.admin.request("PUT", "/v1/team/storage", {
          history_keep: { mode: "days", n: 1 },
        })
      ).status,
    ).toBe(200);
    await fx.admin.query(
      `UPDATE project_commits SET created_at = now() - interval '3 days' WHERE project_id = $1 AND seq <= 2`,
      [id],
    );
    expect(await pruneProjectHistory(fx.db, w.team, { maxCommits: 1000 })).toMatchObject({
      commits: 2,
    });
    expect(await seqs(id)).toEqual([3, 4]);
    expect(
      (await w.as.admin.request("PUT", "/v1/team/storage", { history_keep: { mode: "all" } }))
        .status,
    ).toBe(200);
    expect(await pruneProjectHistory(fx.db, w.team, { maxCommits: 1 })).toMatchObject({
      commits: 1,
    });
    expect(await seqs(id)).toEqual([4]);
    expect((await audits(w.team, "project.history_pruned")).map((t) => t.rule)).toEqual([
      "days",
      "hard_cap",
    ]);
  });
});
