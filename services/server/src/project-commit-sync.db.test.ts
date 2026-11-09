import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  audits,
  auth,
  call,
  fx,
  projectUpload,
  pull,
  push,
  save,
  sha,
  workspaceUpload,
  world,
} from "./testing/project-commits-fixture.js";
import { RawBody } from "./testing/browser.js";

/**
 * KOBE-579 ac-2 and ac-4 (sync and quotas): the sandbox pushes into a project folder only with a
 * checkout and the pull names the checkouts; the byte quota and object budget on commits, pushes,
 * Files uploads, saves and thread uploads; the storage view and its settings.
 */

describe("the sandbox pushes into a project folder only with a checkout (ac-2)", () => {
  it("is read_only without one, applied with one, and relocked after Discard", async () => {
    const w = await world();
    const { id, slug } = w.project;
    await projectUpload(w.as.alice, id, "a.md", "A1");
    const token = auth.issue({ sandboxId: randomUUID(), teamId: w.team, userId: w.people.bob.id });
    expect(await push(token, `projects/${slug}/x.md`, "x1")).toMatchObject({
      status: "rejected",
      code: "read_only",
    });
    expect((await pull(token)).checkouts).toEqual([]);

    expect((await w.as.bob.post(`/v1/projects/${id}/checkout`, {})).status).toBe(200);
    // Every page of the pull names the checkout.
    const first = await pull(token);
    expect(first.checkouts).toEqual([{ project_id: id, slug, base_commit_seq: 1 }]);
    expect(await push(token, `projects/${slug}/x.md`, "x1")).toMatchObject({ status: "applied" });
    // Another project's folder stays read-only, and so does alice's slug for someone without one.
    expect(await push(token, `projects/other-${slug}/y.md`, "y")).toMatchObject({
      code: "read_only",
    });
    const aliceToken = auth.issue({
      sandboxId: randomUUID(),
      teamId: w.team,
      userId: w.people.alice.id,
    });
    expect(await push(aliceToken, `projects/${slug}/z.md`, "z")).toMatchObject({
      code: "read_only",
    });
    // The pushed file is in the working copy diff and commits like any other change.
    expect(
      (await w.as.bob.post(`/v1/projects/${id}/commit`, { message: "from the agent's push" })).json,
    ).toMatchObject({ status: "committed", seq: 2 });

    expect((await w.as.bob.request("DELETE", `/v1/projects/${id}/checkout`)).status).toBe(204);
    expect((await pull(token)).checkouts).toEqual([]);
    expect(await push(token, `projects/${slug}/x.md`, "x2")).toMatchObject({ code: "read_only" });
  });
});

// ------------------------------------------------------------------ quota and storage (ac-4)

describe("quota, object budget and the storage view (ac-4)", () => {
  it("refuses a commit over the byte quota or the object budget, naming the limit", async () => {
    const w = await world();
    const { id, slug } = w.project;
    await projectUpload(w.as.alice, id, "a.md", "A1");
    expect((await w.as.alice.post(`/v1/projects/${id}/checkout`, {})).status).toBe(200);
    expect(
      (await workspaceUpload(w.as.alice, `projects/${slug}`, "big.txt", "x".repeat(4000))).status,
    ).toBe(201);
    const before = await fx.admin.query(
      `SELECT live_bytes, history_bytes, live_objects, history_objects FROM projects WHERE id = $1`,
      [id],
    );
    // Bytes: the team may hold only what it holds now (the working copy is already counted).
    await fx.admin.query(
      `INSERT INTO team_storage_quotas (team_id, max_bytes, updated_by) VALUES ($1, 100, $2)
       ON CONFLICT (team_id) DO UPDATE SET max_bytes = 100`,
      [w.team, w.admin.id],
    );
    const bytes = await w.as.alice.post(`/v1/projects/${id}/commit`, { message: "big" });
    expect(bytes.status).toBe(507);
    expect(bytes.json).toMatchObject({ code: "quota_exceeded", limit: "bytes" });
    // Objects: the budget is what the team holds now; one more object does not fit.
    const used = await fx.admin.query<{ n: string }>(
      `SELECT (SELECT COALESCE(SUM(blob_count), 0) FROM workspace_sync WHERE team_id = $1)
            + (SELECT count(*) FROM files WHERE team_id = $1 AND run_id IS NULL)
            + (SELECT COALESCE(SUM(live_objects + history_objects), 0) FROM projects WHERE team_id = $1) AS n`,
      [w.team],
    );
    await fx.admin.query(
      `UPDATE team_storage_quotas SET max_bytes = NULL, max_objects = $2 WHERE team_id = $1`,
      [w.team, Number(used.rows[0]?.n)],
    );
    const objs = await w.as.alice.post(`/v1/projects/${id}/commit`, { message: "big" });
    expect(objs.status).toBe(507);
    expect(objs.json).toMatchObject({ code: "quota_exceeded", limit: "objects" });
    // Nothing was attributed to the project by the refused commits.
    const after = await fx.admin.query(
      `SELECT live_bytes, history_bytes, live_objects, history_objects FROM projects WHERE id = $1`,
      [id],
    );
    expect(after.rows).toEqual(before.rows);
    // With room, the commit's new object is the project's (live), not the member's.
    await fx.admin.query(`UPDATE team_storage_quotas SET max_objects = NULL WHERE team_id = $1`, [
      w.team,
    ]);
    expect(
      (await w.as.alice.post(`/v1/projects/${id}/commit`, { message: "big" })).json,
    ).toMatchObject({ status: "committed", seq: 2 });
    const counted = await fx.admin.query(
      `SELECT live_bytes, live_objects FROM projects WHERE id = $1`,
      [id],
    );
    expect(counted.rows[0]).toEqual({ live_bytes: "4002", live_objects: 2 });
  });

  it("refuses a sync push, a Files upload and a save of new content past the object budget", async () => {
    const w = await world();
    const { id, slug } = w.project;
    await projectUpload(w.as.alice, id, "a.md", "A1");
    expect((await w.as.bob.post(`/v1/projects/${id}/checkout`, {})).status).toBe(200);
    const token = auth.issue({ sandboxId: randomUUID(), teamId: w.team, userId: w.people.bob.id });
    // A push of content already held goes through; then the budget is exactly what is held.
    expect(await push(token, "notes/one.md", "one")).toMatchObject({ status: "applied" });
    const used = await fx.admin.query<{ n: string }>(
      `SELECT (SELECT COALESCE(SUM(blob_count + pending_blobs), 0) FROM workspace_sync WHERE team_id = $1)
            + (SELECT count(*) FROM files WHERE team_id = $1 AND run_id IS NULL)
            + (SELECT COALESCE(SUM(live_objects + history_objects), 0) FROM projects WHERE team_id = $1) AS n`,
      [w.team],
    );
    await fx.admin.query(
      `INSERT INTO team_storage_quotas (team_id, max_objects, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (team_id) DO UPDATE SET max_objects = EXCLUDED.max_objects`,
      [w.team, Number(used.rows[0]?.n), w.admin.id],
    );
    const data = Buffer.from("two");
    const put = await call(token, "PUT", `/blobs/${sha(data)}`, undefined, data);
    expect(put.status).toBe(507);
    expect(await put.json()).toMatchObject({ code: "quota_exceeded", limit: "objects" });
    // Content the workspace already holds costs no object: the push of the same file elsewhere works.
    expect(await push(token, "notes/again.md", "one")).toMatchObject({ status: "applied" });
    const up = await workspaceUpload(w.as.bob, "notes", "new.md", "brand new");
    expect(up.status).toBe(507);
    expect(up.json).toMatchObject({ code: "quota_exceeded", limit: "objects" });
    const saved = await save(w.as.bob, `projects/${slug}/a.md`, sha("A1"), "changed");
    expect(saved.status).toBe(507);
    expect(saved.json).toMatchObject({ code: "quota_exceeded", limit: "objects" });
  });

  it("reports bytes and objects per project to team admins, and writes the settings (audited)", async () => {
    const w = await world();
    const { id } = w.project;
    await projectUpload(w.as.alice, id, "a.md", "A1");
    await projectUpload(w.as.alice, id, "b.md", "B12");
    expect((await w.as.alice.get("/v1/team/storage")).status).toBe(403);
    const view = await w.as.admin.get("/v1/team/storage");
    expect(view.status, JSON.stringify(view.json)).toBe(200);
    expect(view.json).toMatchObject({
      live_bytes: 5,
      live_objects: 2,
      history_bytes: 0,
      history_objects: 0,
      history_keep: { mode: "all" },
      history_max_commits: 1000,
      max_mounted_per_member: 20,
      max_objects: null,
      projects: [
        {
          project_id: id,
          commits: 2,
          live_bytes: 5,
          live_objects: 2,
          history_bytes: 0,
          history_objects: 0,
        },
      ],
    });
    const put = await w.as.admin.request("PUT", "/v1/team/storage", {
      history_keep: { mode: "commits", n: 5 },
      max_mounted_per_member: 7,
      max_objects: 1234,
    });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json).toMatchObject({
      history_keep: { mode: "commits", n: 5 },
      max_mounted_per_member: 7,
      max_objects: 1234,
    });
    expect(await audits(w.team, "project.storage_settings_changed")).toEqual([
      { historyKeep: { mode: "commits", n: 5 }, maxMountedPerMember: 7, maxObjects: 1234 },
    ]);
    expect(
      (await w.as.admin.request("PUT", "/v1/team/storage", { history_keep: { mode: "weeks" } }))
        .status,
    ).toBe(400);
  });
});

// ------------------------------------------------------------------ losing edit, export

describe("the object budget on thread uploads and its ceiling", () => {
  it("refuses a thread upload past the object budget with 507", async () => {
    const w = await world();
    const used = await fx.admin.query<{ n: string }>(
      `SELECT (SELECT COALESCE(SUM(blob_count + pending_blobs), 0) FROM workspace_sync WHERE team_id = $1)
            + (SELECT count(*) FROM files WHERE team_id = $1 AND run_id IS NULL)
            + (SELECT COALESCE(SUM(live_objects + history_objects), 0) FROM projects WHERE team_id = $1) AS n`,
      [w.team],
    );
    await fx.admin.query(
      `INSERT INTO team_storage_quotas (team_id, max_objects, updated_by) VALUES ($1, $2, $3)`,
      [w.team, Number(used.rows[0]?.n), w.admin.id],
    );
    const boundary = `----kobe${randomUUID().slice(0, 8)}`;
    const bytes = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="t.txt"\r\n` +
        `Content-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`,
    );
    const res = await w.as.alice.request(
      "POST",
      "/v1/uploads",
      new RawBody(bytes, `multipart/form-data; boundary=${boundary}`),
      { "content-length": String(bytes.length) },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(507);
    expect(res.json).toMatchObject({ code: "quota_exceeded" });
    expect(String((res.json as { message: string }).message)).toContain("object");
  });

  it("lets a team admin set max_objects only at or below the site default", async () => {
    const w = await world();
    expect(
      (await w.as.admin.request("PUT", "/v1/team/storage", { max_objects: 2_000_001 })).status,
    ).toBe(400);
    expect(
      (await w.as.admin.request("PUT", "/v1/team/storage", { max_objects: 2_000_000 })).status,
    ).toBe(200);
    expect(
      (await w.as.admin.request("PUT", "/v1/team/storage", { max_objects: null })).status,
    ).toBe(200);
  });
});
