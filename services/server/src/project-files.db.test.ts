import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { RawBody } from "./testing/browser.js";
import type { Person } from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { RunFixture } from "./testing/run-fixture.js";
import { createWorkspaceSync } from "./workspace-sync/index.js";
import { listLive } from "./workspace-sync/store.js";

/**
 * KOBE-162 (ac-1): the project files API and how files reach members' workspaces. The `projects/`
 * area of a (team, user) workspace must hold exactly the files of the projects that user is a
 * member of, as server writes (read-only to the sandbox, KOBE-27), updated when files or members
 * change and re-checked at every run start.
 */
const f = new RunFixture();
const objects = new MemoryObjects();
const PREFIX = "kobe/";
const silent = { error: () => {}, warn: () => {}, info: () => {} };

beforeAll(async () => {
  await f.setup({ blobs: { objects, prefix: PREFIX } });
  const sync = createWorkspaceSync({
    db: f.fx.db,
    objects,
    prefix: PREFIX,
    limits: { maxFileBytes: 1024 * 1024, maxWorkspaceBytes: 8 * 1024 * 1024, maxFiles: 1000 },
    log: silent,
  });
  for (const r of f.fx.replicas) r.deps.projectMounts.use(sync);
});
afterAll(async () => {
  await f.teardown();
});

const as = (p: Person) => f.on(0, p);

async function builder(team: string): Promise<Person> {
  const p = await f.member(team);
  await f.fx.admin.query(
    `UPDATE team_members SET role = 'builder' WHERE team_id = $1 AND user_id = $2`,
    [team, p.id],
  );
  return p;
}

function multipart(fields: Record<string, string>, file: { name: string; data: string }) {
  const boundary = `----kobe${randomBytes(6).toString("hex")}`;
  let body = "";
  for (const [k, v] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  body +=
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
    `Content-Type: text/markdown\r\n\r\n${file.data}\r\n--${boundary}--\r\n`;
  const bytes = Buffer.from(body);
  return {
    raw: new RawBody(bytes, `multipart/form-data; boundary=${boundary}`),
    headers: { "content-length": String(bytes.length) },
  };
}

function upload(p: Person, project: string, name: string, data: string, folder?: string) {
  const m = multipart(folder === undefined ? {} : { path: folder }, { name, data });
  return as(p).request("POST", `/v1/projects/${project}/files`, m.raw, m.headers);
}

async function create(p: Person, body: Record<string, unknown>) {
  const res = await as(p).post("/v1/projects", body);
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json as { id: string; slug: string };
}

/** What `userId`'s workspace names under `projects/` (path -> sha256), straight from the manifest. */
async function mounted(team: string, userId: string): Promise<Record<string, string | undefined>> {
  const entries = await withTeam(f.fx.db, team, (tx) =>
    listLive(tx, { teamId: team, userId }, "projects/", 1000),
  );
  for (const e of entries) expect(e.origin).toBe("server");
  return Object.fromEntries(entries.map((e) => [e.path, e.sha256]));
}

const paths = async (team: string, userId: string) => Object.keys(await mounted(team, userId));

describe("project files API", () => {
  it("lets owners and admins add and remove files; members and outsiders cannot", async () => {
    const w = await f.world();
    const b = await builder(w.team);
    const m = await f.member(w.team);
    const project = await create(b, { name: "Docs" });
    const outsider = await f.member(w.team);
    const hidden = await create(b, {
      name: "Hidden",
      members_mode: "selected",
      member_user_ids: [m.id],
    });

    const up = await upload(b, project.id, "brief.md", "# brief\n", "docs");
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    expect(up.json).toMatchObject({
      project_id: project.id,
      path: "docs/brief.md",
      size_bytes: 8,
      source: "upload",
      added_by: b.id,
    });
    expect((await as(m).get(`/v1/projects/${project.id}/files`)).json.files).toHaveLength(1);
    expect((await as(m).get(`/v1/projects/${project.id}`)).json.file_count).toBe(1);
    // A member uses the files but does not manage them; a non-member of a selected project sees nothing.
    expect((await upload(m, project.id, "x.md", "x")).status).toBe(403);
    expect((await as(m).delete(`/v1/projects/${project.id}/files/${up.json.id}`)).status).toBe(403);
    expect((await upload(outsider, hidden.id, "x.md", "x")).status).toBe(404);
    expect((await as(outsider).get(`/v1/projects/${hidden.id}/files`)).status).toBe(404);
    // Same name and folder again; names and folders that could leave the project folder.
    expect((await upload(b, project.id, "brief.md", "again", "docs")).json.code).toBe(
      "already_exists",
    );
    expect((await upload(b, project.id, "ok.md", "x", "../escape")).status).toBeGreaterThanOrEqual(
      400,
    );
    expect((await upload(b, project.id, "ok.md", "x", "/abs")).status).toBeGreaterThanOrEqual(400);
    expect((await as(b).get(`/v1/projects/${project.id}/files`)).json.files).toHaveLength(1);

    const key = (
      await f.fx.admin.query<{ blob_ref: string }>(
        `SELECT blob_ref FROM project_files WHERE team_id = $1`,
        [w.team],
      )
    ).rows[0]?.blob_ref;
    expect(key).toMatch(new RegExp(`^${PREFIX}teams/${w.team}/projects/${project.id}/files/`));
    expect(objects.objects.get(key ?? "")?.toString()).toBe("# brief\n");
    // Deleting a project that still has files is refused; removing the file ends the object.
    expect((await as(b).delete(`/v1/projects/${project.id}`)).status).toBe(409);
    expect((await as(b).delete(`/v1/projects/${project.id}/files/${up.json.id}`)).status).toBe(204);
    expect((await as(b).delete(`/v1/projects/${project.id}/files/${up.json.id}`)).status).toBe(404);
    expect(objects.objects.has(key ?? "")).toBe(false);
    const audits = await f.fx.admin.query<{ action: string; target: Record<string, unknown> }>(
      `SELECT action, target FROM audit_log WHERE team_id = $1 AND action LIKE 'project.file_%' ORDER BY seq`,
      [w.team],
    );
    expect(audits.rows.map((r) => r.action)).toEqual([
      "project.file_added",
      "project.file_removed",
    ]);
    expect(JSON.stringify(audits.rows)).not.toContain("brief");
  });
});

describe("project files in members' workspaces", () => {
  it("mounts under projects/<slug>/ for members only and follows adds and removals", async () => {
    const w = await f.world();
    const b = await builder(w.team);
    const m1 = await f.member(w.team);
    const m2 = await f.member(w.team);
    const project = await create(b, {
      name: "Secret Plans",
      members_mode: "selected",
      member_user_ids: [m1.id],
    });
    expect((await upload(b, project.id, "a.md", "A", "docs")).status).toBe(201);
    expect((await upload(b, project.id, "b.md", "B")).status).toBe(201);
    const expected = [`projects/${project.slug}/b.md`, `projects/${project.slug}/docs/a.md`];

    expect(await paths(w.team, m1.id)).toEqual(expected);
    // The creator is an owner (explicit row), a non-member of the selected project is not mounted.
    expect(await paths(w.team, b.id)).toEqual(expected);
    expect(await paths(w.team, m2.id)).toEqual([]);
    // Team admins manage the project but are not members: nothing is mounted for them.
    expect(await paths(w.team, w.owner.id)).toEqual([]);

    // Adding a member mounts, removing one unmounts (by the next run, no later than the sync pull).
    expect(
      await as(b).post(`/v1/projects/${project.id}/members`, { user_id: m2.id }),
    ).toMatchObject({ status: 201 });
    expect(await paths(w.team, m2.id)).toEqual(expected);
    expect((await as(b).delete(`/v1/projects/${project.id}/members/${m1.id}`)).status).toBe(204);
    expect(await paths(w.team, m1.id)).toEqual([]);
    expect(await paths(w.team, m2.id)).toEqual(expected);

    // Removing a file unmounts it everywhere; adding one reaches the remaining members.
    const list = (await as(b).get(`/v1/projects/${project.id}/files`)).json.files as {
      id: string;
      path: string;
    }[];
    const a = list.find((x) => x.path === "docs/a.md");
    expect((await as(b).delete(`/v1/projects/${project.id}/files/${a?.id}`)).status).toBe(204);
    expect(await paths(w.team, m2.id)).toEqual([`projects/${project.slug}/b.md`]);
    expect((await upload(b, project.id, "c.md", "C")).status).toBe(201);
    expect(await paths(w.team, m2.id)).toEqual([
      `projects/${project.slug}/b.md`,
      `projects/${project.slug}/c.md`,
    ]);
    // Every mounted path is inside the project's own folder, whatever the file names were.
    for (const p of await paths(w.team, m2.id))
      expect(p.startsWith(`projects/${project.slug}/`)).toBe(true);
  });

  it("mounts for the whole team in mode team, and un-mounts when the mode narrows", async () => {
    const w = await f.world();
    const b = await builder(w.team);
    const m1 = await f.member(w.team);
    const m2 = await f.member(w.team);
    const project = await create(b, { name: "Everyone" });
    await upload(b, project.id, "all.md", "all");
    for (const p of [b, m1, m2, w.owner]) {
      expect(await paths(w.team, p.id)).toEqual([`projects/${project.slug}/all.md`]);
    }
    // Narrowed to the creator only: the others lose it.
    await as(b).post(`/v1/projects/${project.id}/members`, { user_id: m1.id });
    expect(
      (await as(b).patch(`/v1/projects/${project.id}`, { members_mode: "selected" })).status,
    ).toBe(200);
    expect(await paths(w.team, m1.id)).toHaveLength(1);
    expect(await paths(w.team, b.id)).toHaveLength(1);
    expect(await paths(w.team, m2.id)).toEqual([]);
    expect(await paths(w.team, w.owner.id)).toEqual([]);
  });

  it("brings a workspace in line at every run start, and takes everything from a removed member", async () => {
    const w = await f.world(1);
    const b = await builder(w.team);
    const project = await create(b, { name: "Run Start" });
    await upload(b, project.id, "r.md", "R");
    const [member] = w.others;
    if (!member) throw new Error("member");
    const slugPath = `projects/${project.slug}/r.md`;
    expect(await paths(w.team, member.id)).toEqual([slugPath]);

    // A missed update: the rows are gone. The next run start restores them before the sandbox pulls.
    await f.fx.admin.query(
      `DELETE FROM workspace_files WHERE team_id = $1 AND user_id = $2 AND path LIKE 'projects/%'`,
      [w.team, member.id],
    );
    expect(await paths(w.team, member.id)).toEqual([]);
    const ws = await f.connect({
      team: w.team,
      owner: member,
      target: { teamId: w.team, userId: member.id },
    });
    const thread = await f.thread(member);
    const run = await f.message(member, thread, "hello");
    await ws.started(run);
    expect(await paths(w.team, member.id)).toEqual([slugPath]);

    // The user leaves the team: nothing stays mounted for them, whatever else is reconciled.
    await f.fx.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      w.team,
      member.id,
    ]);
    await f.fx.replica(0).deps.projectMounts.reconcileUser(w.team, member.id);
    expect(await paths(w.team, member.id)).toEqual([]);
  });
});
