import { describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import {
  PREFIX,
  audits,
  detail,
  fx,
  multipart,
  objects,
  rows,
  setHold,
  sha,
  treeOf,
  workspaceUpload,
  world,
  type World,
} from "./testing/project-commits-fixture.js";
import type { TestBrowser } from "./testing/browser.js";
import { listLive } from "./workspace-sync/store.js";

/**
 * KOBE-586 (projects-in-conversations PF1-PF6) against a real Postgres: a My files folder becomes
 * a project in one commit, the folder leaves My files and the project mounts for its creator;
 * the permission matrix, every limit refused up front, and failures that leave My files and the
 * projects untouched. Also PF5: a project made from the Projects page mounts for its creator.
 * World (`testing/project-commits-fixture.ts`): admin (team admin), alice (contributor), bob
 * and carol (team members).
 */

const promote = (b: TestBrowser, path: string, name: string) =>
  b.post("/v1/projects/from-folder", { path, name });

async function myFiles(w: World, userId: string): Promise<Record<string, string>> {
  const entries = await withTeam(fx.db, w.team, (tx) =>
    listLive(tx, { teamId: w.team, userId }, "", 10_000),
  );
  return Object.fromEntries(
    entries.filter((e) => !e.path.startsWith("projects/")).map((e) => [e.path, e.sha256 ?? ""]),
  );
}

async function projectCount(team: string): Promise<number> {
  const res = await fx.admin.query<{ n: string }>(
    `SELECT count(*) AS n FROM projects WHERE team_id = $1`,
    [team],
  );
  return Number(res.rows[0]?.n);
}

async function seed(w: World, b: TestBrowser = w.as.alice) {
  for (const [folder, name, content] of [
    ["docs", "a.md", "A"],
    ["docs/sub", "b.md", "B"],
    ["docs/sub", "dup.md", "A"],
    ["", "keep.md", "K"],
  ] as const) {
    expect((await workspaceUpload(b, folder, name, content)).status).toBe(201);
  }
}

/** Nothing changed: the same My files and no new project. */
async function untouched(w: World, userId: string, files: Record<string, string>, n: number) {
  expect(await myFiles(w, userId)).toEqual(files);
  expect(await projectCount(w.team)).toBe(n);
}

describe("promote a My files folder (PF3)", () => {
  it("moves the folder into a new project in one commit, then mounts it for the creator", async () => {
    const w = await world();
    await seed(w);
    const res = await promote(w.as.alice, "docs", "Quarterly Docs");
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const made = res.json as { id: string; slug: string; my_role: string; file_count: number };
    expect(made).toMatchObject({
      slug: "quarterly-docs",
      name: "Quarterly Docs",
      my_role: "owner",
      file_count: 3,
      created_by: w.people.alice.id,
    });

    // One commit with the whole tree, sub-folders kept as paths, author the member.
    const d = await detail(w.as.alice, made.id, 1);
    expect(d.commit).toMatchObject({ seq: 1, author_kind: "user" });
    expect((d.commit as { message?: string }).message).toBe("Imported from My files/docs");
    expect(treeOf(d)).toEqual({ "a.md": sha("A"), "sub/b.md": sha("B"), "sub/dup.md": sha("A") });
    expect((await w.as.alice.get(`/v1/projects/${made.id}/commits/2`)).status).toBe(404);
    // Blobs copied server-side into the project's prefix (one object per content).
    for (const s of ["A", "B"]) {
      const key = `${PREFIX}teams/${w.team}/projects/${made.id}/blobs/${sha(s)}`;
      expect(objects.objects.get(key)?.toString()).toBe(s);
    }

    // The folder left My files; the rest stayed; the project is mounted for alice.
    expect(await myFiles(w, w.people.alice.id)).toEqual({ "keep.md": sha("K") });
    const mounted = await rows(w.team, w.people.alice.id, made.slug);
    expect([...mounted.keys()].sort()).toEqual(["a.md", "sub/b.md", "sub/dup.md"]);
    expect(mounted.get("a.md")?.origin).toBe("server");

    // Audit: created, committed (ids and counts, no names), and the workspace delete.
    expect(await audits(w.team, "project.created")).toContainEqual({ projectId: made.id });
    const committed = await audits(w.team, "project.committed");
    expect(committed.at(-1)).toMatchObject({
      projectId: made.id,
      seq: 1,
      authorKind: "user",
      added: 3,
      fileCount: 3,
    });
    expect(JSON.stringify(committed)).not.toContain("a.md");
    expect((await audits(w.team, "workspace.file_deleted")).at(-1)).toEqual({
      userId: w.people.alice.id,
      files: 3,
      bytes: 3,
    });
  });

  it("lets team admins and contributors promote; members get 403 and nothing changes", async () => {
    const w = await world();
    await seed(w, w.as.bob);
    const before = await myFiles(w, w.people.bob.id);
    const n = await projectCount(w.team);
    const refused = await promote(w.as.bob, "docs", "Docs");
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ code: "forbidden" });
    await untouched(w, w.people.bob.id, before, n);

    await seed(w, w.as.admin);
    expect((await promote(w.as.admin, "docs", "Admin docs")).status).toBe(201);
  });

  it("resolves the path against the caller's own files only", async () => {
    const w = await world();
    await seed(w);
    const before = await myFiles(w, w.people.alice.id);
    const n = await projectCount(w.team);
    // The admin has no docs/ (folders exist only through files): alice's is never reached.
    const admin = await promote(w.as.admin, "docs", "Hers");
    expect(admin.status).toBe(422);
    expect(String((admin.json as { message: string }).message)).toContain("empty");
    // Another workspace's contributor neither.
    const other = await world();
    expect((await promote(other.as.alice, "docs", "Hers")).status).toBe(422);
    await untouched(w, w.people.alice.id, before, n);
  });

  it("derives a free slug when the name's is taken", async () => {
    const w = await world();
    await seed(w);
    expect((await w.as.alice.post("/v1/projects", { name: "Docs" })).status).toBe(201);
    const res = await promote(w.as.alice, "docs", "Docs");
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json).toMatchObject({ slug: "docs-2" });
  });
});

describe("limits refused up front (PF4), My files and projects untouched", () => {
  it("refuses paths outside My files, files, empty and unknown folders", async () => {
    const w = await world();
    await seed(w);
    expect((await workspaceUpload(w.as.alice, "uploads", "drop.md", "D")).status).toBe(201);
    const before = await myFiles(w, w.people.alice.id);
    const n = await projectCount(w.team);
    const cases: [string, number, string][] = [
      ["uploads", 422, "My files"],
      [`projects/${w.project.slug}`, 422, "My files"],
      ["projects", 422, "My files"],
      [".kobe", 404, ""],
      [".kobe/sessions", 404, ""],
      ["keep.md", 422, "folder"],
      ["nowhere", 422, "This folder is empty; create the project from Projects instead"],
    ];
    for (const [path, status, words] of cases) {
      const res = await promote(w.as.alice, path, "X");
      expect(res.status, `${path}: ${JSON.stringify(res.json)}`).toBe(status);
      expect(String((res.json as { message: string }).message)).toContain(words);
    }
    expect((await promote(w.as.alice, "docs", " ")).status).toBe(400);
    expect((await w.as.alice.post("/v1/projects/from-folder", { path: "docs" })).status).toBe(400);
    expect(
      (await w.as.alice.post("/v1/projects/from-folder", { path: "docs", name: "D", x: 1 })).status,
    ).toBe(400);
    await untouched(w, w.people.alice.id, before, n);
  });

  it("refuses more than 500 files, a file too large and a conflict copy, naming it", async () => {
    const w = await world();
    await seed(w);
    expect((await workspaceUpload(w.as.alice, "many", "f0.md", "M")).status).toBe(201);
    await fx.admin.query(
      `INSERT INTO workspace_files
       SELECT (jsonb_populate_record(w, jsonb_build_object('path', 'many/f' || g || '.md'))).*
         FROM workspace_files w, generate_series(1, 500) g
        WHERE w.team_id = $1 AND w.user_id = $2 AND w.path = 'many/f0.md'`,
      [w.team, w.people.alice.id],
    );
    const before = await myFiles(w, w.people.alice.id);
    const n = await projectCount(w.team);
    const many = await promote(w.as.alice, "many", "Many");
    expect(many.status).toBe(422);
    expect(String((many.json as { message: string }).message)).toContain("500");

    await fx.admin.query(
      `UPDATE workspace_files SET size = 60 * 1024 * 1024
        WHERE team_id = $1 AND user_id = $2 AND path = 'docs/sub/b.md'`,
      [w.team, w.people.alice.id],
    );
    const big = await promote(w.as.alice, "docs", "Big");
    expect(big.status).toBe(413);
    expect(String((big.json as { message: string }).message)).toContain("sub/b.md");
    await fx.admin.query(
      `UPDATE workspace_files SET size = 1
        WHERE team_id = $1 AND user_id = $2 AND path = 'docs/sub/b.md'`,
      [w.team, w.people.alice.id],
    );

    expect(
      (await workspaceUpload(w.as.alice, "docs", "a.conflict-20260101T000000Z.md", "C")).status,
    ).toBe(201);
    const conflict = await promote(w.as.alice, "docs", "Conflict");
    expect(conflict.status).toBe(422);
    expect(String((conflict.json as { message: string }).message)).toContain(".conflict-");
    const after = await myFiles(w, w.people.alice.id);
    expect(after).toMatchObject(before);
    expect(await projectCount(w.team)).toBe(n);
  });

  it("refuses past the byte quota and the object budget (507 quota_exceeded)", async () => {
    const w = await world();
    await seed(w);
    const before = await myFiles(w, w.people.alice.id);
    const n = await projectCount(w.team);
    await fx.admin.query(
      `INSERT INTO team_storage_quotas (team_id, max_bytes, updated_by) VALUES ($1, 1, $2)
       ON CONFLICT (team_id) DO UPDATE SET max_bytes = 1`,
      [w.team, w.admin.id],
    );
    const bytes = await promote(w.as.alice, "docs", "Bytes");
    expect(bytes.status).toBe(507);
    expect(bytes.json).toMatchObject({ code: "quota_exceeded", limit: "bytes" });
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
    const objs = await promote(w.as.alice, "docs", "Objects");
    expect(objs.status).toBe(507);
    expect(objs.json).toMatchObject({ code: "quota_exceeded", limit: "objects" });
    await untouched(w, w.people.alice.id, before, n);
  });

  it("leaves everything as it was when a copy fails its hash check or a legal hold applies", async () => {
    const w = await world();
    await seed(w);
    const before = await myFiles(w, w.people.alice.id);
    const n = await projectCount(w.team);
    const src = `${PREFIX}teams/${w.team}/users/${w.people.alice.id}/workspace/${sha("B")}`;
    const good = objects.objects.get(src);
    expect(good).toBeDefined();
    objects.objects.set(src, Buffer.from("tampered"));
    const bad = await promote(w.as.alice, "docs", "Tampered");
    expect(bad.status).toBe(503);
    await untouched(w, w.people.alice.id, before, n);
    objects.objects.set(src, good ?? Buffer.from("B"));

    await setHold(w.team, w.admin.id, true);
    const held = await promote(w.as.alice, "docs", "Held");
    expect(held.status).toBe(409);
    expect(held.json).toMatchObject({ code: "legal_hold" });
    await untouched(w, w.people.alice.id, before, n);
    await setHold(w.team, w.admin.id, false);
    expect((await promote(w.as.alice, "docs", "After")).status).toBe(201);
  });
});

describe("mount on create (PF5)", () => {
  it("mounts a project made on the Projects page for its creator until MT1 takes over", async () => {
    const w = await world();
    const made = await w.as.alice.post("/v1/projects", { name: "Fresh" });
    expect(made.status).toBe(201);
    const p = made.json as { id: string; slug: string };
    const { body, bytes } = multipart("f.md", "F");
    expect(
      (
        await w.as.alice.request("POST", `/v1/projects/${p.id}/files`, body, {
          "content-length": String(bytes.length),
        })
      ).status,
    ).toBe(201);
    // No conversation yet: mounted for alice (the creator), not for anyone else.
    expect([...(await rows(w.team, w.people.alice.id, p.slug)).keys()]).toEqual(["f.md"]);
    expect([...(await rows(w.team, w.people.bob.id, p.slug)).keys()]).toEqual([]);

    // Her first conversation in it, then Trash: MT1 decides from then on (unmounted).
    const t = await w.as.alice.post("/v1/threads", { project_id: p.id });
    expect(t.status).toBe(201);
    expect(
      (await w.as.alice.delete(`/v1/threads/${(t.json as { thread_id: string }).thread_id}`))
        .status,
    ).toBe(200);
    expect([...(await rows(w.team, w.people.alice.id, p.slug)).keys()]).toEqual([]);
  });
});
