import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { RawBody } from "./testing/browser.js";
import type { Person } from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { RunFixture } from "./testing/run-fixture.js";
import { createWorkspaceSync } from "./workspace-sync/index.js";
import { listLive } from "./workspace-sync/store.js";
import { MOUNTS_MAX_SETTING } from "./projects/mounts.js";
import { endUserProjects } from "./projects/offboard.js";

/**
 * KOBE-578 (Workspaces MT1-MT4, ac-2): a project is mounted into a member's workspace only while
 * they have a thread of their own in it that is not in Trash, or a checkout; every workspace member
 * reads every project (KOBE-587), so losing a row or team admin keeps the mount; leaving the workspace unmounts everything and discards checkouts; a new
 * project conversation past the workspace cap is refused `too_many_mounts`.
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

async function contributor(team: string): Promise<Person> {
  const p = await f.member(team);
  await f.fx.admin.query(
    `UPDATE team_members SET role = 'contributor' WHERE team_id = $1 AND user_id = $2`,
    [team, p.id],
  );
  return p;
}

async function upload(p: Person, projectId: string, name: string) {
  const boundary = `----kobe${randomBytes(6).toString("hex")}`;
  const bytes = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      `Content-Type: text/markdown\r\n\r\n${name}\r\n--${boundary}--\r\n`,
  );
  const up = await as(p).request(
    "POST",
    `/v1/projects/${projectId}/files`,
    new RawBody(bytes, `multipart/form-data; boundary=${boundary}`),
    { "content-length": String(bytes.length) },
  );
  expect(up.status, JSON.stringify(up.json)).toBe(201);
}

async function project(p: Person, body: Record<string, unknown>) {
  const res = await as(p).post("/v1/projects", body);
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  const made = res.json as { id: string; slug: string };
  await upload(p, made.id, "f.md");
  return { ...made, path: `projects/${made.slug}/f.md` };
}

async function thread(p: Person, projectId: string | null) {
  const res = await as(p).post("/v1/threads", projectId === null ? {} : { project_id: projectId });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.thread_id as string;
}

async function paths(team: string, userId: string): Promise<string[]> {
  const entries = await withTeam(f.fx.db, team, (tx) =>
    listLive(tx, { teamId: team, userId }, "projects/", 1000),
  );
  return entries.map((e) => e.path).sort();
}

describe("mount on conversation (MT1)", () => {
  it("appears on the first project thread, survives a second, goes with the last one in Trash", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    const m = await f.member(w.team);
    const p = await project(c, { name: "Mounted" });
    // Readable but not open: nothing mounted (the creator has no conversation in it either).
    expect(await paths(w.team, m.id)).toEqual([]);
    expect(await paths(w.team, c.id)).toEqual([]);

    const first = await thread(m, p.id);
    expect(await paths(w.team, m.id)).toEqual([p.path]);
    const second = await thread(m, p.id);
    expect((await as(m).delete(`/v1/threads/${first}`)).status).toBe(200);
    expect(await paths(w.team, m.id)).toEqual([p.path]);
    expect((await as(m).delete(`/v1/threads/${second}`)).status).toBe(200);
    expect(await paths(w.team, m.id)).toEqual([]);
    // Restore brings it back; moving the thread out takes it away; moving in mounts again.
    expect((await as(m).post(`/v1/threads/${second}/restore`)).status).toBe(200);
    expect(await paths(w.team, m.id)).toEqual([p.path]);
    expect((await as(m).post(`/v1/threads/${second}/move`, { project_id: null })).status).toBe(200);
    expect(await paths(w.team, m.id)).toEqual([]);
    expect((await as(m).post(`/v1/threads/${second}/move`, { project_id: p.id })).status).toBe(200);
    expect(await paths(w.team, m.id)).toEqual([p.path]);
    // A thread shared to the project that they only read does not mount it for others.
    expect(await paths(w.team, c.id)).toEqual([]);
  });

  it("leaves a checked-out project's folder to the member (reconcile skips it)", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    const p = await project(c, { name: "Checked" });
    await thread(c, p.id);
    expect(await paths(w.team, c.id)).toEqual([p.path]);
    // A checkout (KOBE-579 writes it; here by SQL): the folder is the member's working copy.
    await f.fx.admin.query(
      `INSERT INTO project_checkouts (team_id, project_id, user_id) VALUES ($1, $2, $3)`,
      [w.team, p.id, c.id],
    );
    // A new head file is not written into the working copy, nothing is deleted from it.
    await upload(c, p.id, "g.md");
    expect(await paths(w.team, c.id)).toEqual([p.path]);
    // The checkout ends (Discard, KOBE-579): the next reconcile brings the folder back to the head.
    await f.fx.admin.query(`DELETE FROM project_checkouts WHERE team_id = $1 AND user_id = $2`, [
      w.team,
      c.id,
    ]);
    await f.fx.replica(0).deps.projectMounts.reconcileUser(w.team, c.id);
    expect(await paths(w.team, c.id)).toEqual([p.path, `projects/${p.slug}/g.md`].sort());
  });
});

describe("losing access and leaving (MT2, MT4)", () => {
  it("reconciles a stale mounted member when a file is removed", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    const m = await f.member(w.team);
    const p = await project(c, { name: "Stale" });
    await thread(m, p.id);
    expect(await paths(w.team, m.id)).toEqual([p.path]);
    // Their thread leaves without a reconcile (as rows mounted under the old rule after an upgrade).
    await f.fx.admin.query(
      `UPDATE threads SET deleted_at = now() WHERE team_id = $1 AND owner_user_id = $2`,
      [w.team, m.id],
    );
    const files = (await as(c).get(`/v1/projects/${p.id}/files`)).json.files as { id: string }[];
    const key = (
      await f.fx.admin.query<{ blob_ref: string }>(
        `SELECT blob_ref FROM project_files WHERE team_id = $1 AND project_id = $2`,
        [w.team, p.id],
      )
    ).rows[0]?.blob_ref as string;
    expect((await as(c).delete(`/v1/projects/${p.id}/files/${files[0]?.id}`)).status).toBe(204);
    expect(await paths(w.team, m.id)).toEqual([]);
    // The object stays: the commit before the removal still names it (KOBE-579, GV3).
    expect(objects.objects.has(key)).toBe(true);
  });

  it("a demoted team admin keeps the mounts of projects they are not listed in (a reader, RV1)", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    const admin2 = await f.member(w.team);
    await f.fx.admin.query(
      `UPDATE team_members SET role = 'team_admin' WHERE team_id = $1 AND user_id = $2`,
      [w.team, admin2.id],
    );
    const p = await project(c, { name: "Admins too" });
    await thread(admin2, p.id);
    expect(await paths(w.team, admin2.id)).toEqual([p.path]);
    const res = await as(w.owner).patch(`/v1/team/members/${admin2.id}`, { role: "member" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await paths(w.team, admin2.id)).toEqual([p.path]);
  });

  it("an editor whose row is removed keeps the mount as a reader (RV1)", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    const r = await f.member(w.team);
    const p = await project(c, { name: "Demoted" });
    await as(c).post(`/v1/projects/${p.id}/members`, { user_id: r.id, role: "editor" });
    await thread(r, p.id);
    expect(await paths(w.team, r.id)).toEqual([p.path]);
    expect((await as(c).delete(`/v1/projects/${p.id}/members/${r.id}`)).status).toBe(204);
    expect(await paths(w.team, r.id)).toEqual([p.path]);
  });

  it("leaving the workspace unmounts everything, discards checkouts and drops project rows", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    const m = await f.member(w.team);
    const open = await project(c, { name: "Everyone" });
    const closed = await project(c, { name: "Few" });
    await as(c).post(`/v1/projects/${closed.id}/members`, { user_id: m.id, role: "editor" });
    await thread(m, open.id);
    await thread(m, closed.id);
    expect(await paths(w.team, m.id)).toEqual([closed.path, open.path].sort());
    await f.fx.admin.query(
      `INSERT INTO project_checkouts (team_id, project_id, user_id) VALUES ($1, $2, $3)`,
      [w.team, closed.id, m.id],
    );

    expect((await as(w.owner).delete(`/v1/team/members/${m.id}`)).status).toBe(204);
    expect(await paths(w.team, m.id)).toEqual([]);
    const left = await f.fx.admin.query(
      `SELECT (SELECT count(*) FROM project_checkouts WHERE team_id = $1 AND user_id = $2) AS checkouts,
              (SELECT count(*) FROM project_members WHERE team_id = $1 AND user_id = $2) AS rows`,
      [w.team, m.id],
    );
    expect(left.rows[0]).toEqual({ checkouts: "0", rows: "0" });
    const audit = await f.fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'project.checkout_discarded'`,
      [w.team],
    );
    expect(audit.rows.map((r) => r.target)).toEqual([
      { projectId: closed.id, userId: m.id, reason: "member_removed" },
    ]);
  });
});

describe("deactivation (MT4)", () => {
  it("ends checkouts and project rows in every workspace and unmounts", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    const m = await f.member(w.team);
    const p = await project(c, { name: "Deact" });
    await as(c).post(`/v1/projects/${p.id}/members`, { user_id: m.id, role: "editor" });
    await thread(m, p.id);
    await f.fx.admin.query(
      `INSERT INTO project_checkouts (team_id, project_id, user_id) VALUES ($1, $2, $3)`,
      [w.team, p.id, m.id],
    );
    expect(await paths(w.team, m.id)).toEqual([p.path]);
    await f.fx.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [m.id]);
    const deps = f.fx.replica(0).deps;
    await endUserProjects(f.fx.db, deps.projectMounts, m.id);
    expect(await paths(w.team, m.id)).toEqual([]);
    const left = await f.fx.admin.query(
      `SELECT (SELECT count(*) FROM project_checkouts WHERE team_id = $1 AND user_id = $2) AS checkouts,
              (SELECT count(*) FROM project_members WHERE team_id = $1 AND user_id = $2) AS rows`,
      [w.team, m.id],
    );
    expect(left.rows[0]).toEqual({ checkouts: "0", rows: "0" });
  });
});

describe("the mount cap (MT3)", () => {
  it("refuses a conversation that would open one project too many, with the limit", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    await f.fx.admin.query(
      `UPDATE teams SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), $2, '2'::jsonb) WHERE id = $1`,
      [w.team, `{${MOUNTS_MAX_SETTING}}`],
    );
    const [a, b, third] = [
      await project(c, { name: "A" }),
      await project(c, { name: "B" }),
      await project(c, { name: "C" }),
    ];
    const inA = await thread(c, a.id);
    await thread(c, b.id);
    // Another conversation in an open project is fine; a third project is refused.
    await thread(c, a.id);
    const refused = await as(c).post("/v1/threads", { project_id: third.id });
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: "too_many_mounts", limit: 2 });
    expect(refused.json.message).toContain("2");
    const loose = await thread(c, null);
    expect(
      (await as(c).post(`/v1/threads/${loose}/move`, { project_id: third.id })).json,
    ).toMatchObject({ code: "too_many_mounts", limit: 2 });
    // A keeps a second thread, so moving one of A's threads to C still needs a third mount.
    expect((await as(c).post(`/v1/threads/${inA}/move`, { project_id: third.id })).status).toBe(
      409,
    );
    expect(await paths(w.team, c.id)).toEqual([a.path, b.path].sort());
  });

  it("defaults to 20 open projects per member", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    for (let i = 0; i < 20; i += 1) {
      const res = await as(c).post("/v1/projects", { name: `P${i}` });
      await thread(c, res.json.id as string);
    }
    const p21 = await as(c).post("/v1/projects", { name: "P20" });
    const refused = await as(c).post("/v1/threads", { project_id: p21.json.id });
    expect(refused.json).toMatchObject({ code: "too_many_mounts", limit: 20 });
  }, 60_000);
});
