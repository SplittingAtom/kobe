import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RawBody } from "./testing/browser.js";
import type { Person } from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { RunFixture } from "./testing/run-fixture.js";

/**
 * KOBE-578 (Workspaces WS-3, ac-1 and ac-3): the PR3 matrix row by row through the API, the
 * creation gate (PR4), `?role=editor` (PJ2), owners and ownership transfer (PR5), the project
 * memory write gate (PR6), restricted visibility answering 404 everywhere, and the project access
 * a run starts with.
 */
const f = new RunFixture();
const objects = new MemoryObjects();

beforeAll(async () => {
  await f.setup({ blobs: { objects, prefix: "kobe/" } });
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

async function create(p: Person, body: Record<string, unknown>) {
  const res = await as(p).post("/v1/projects", body);
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json as { id: string; slug: string };
}

function upload(p: Person, project: string, name: string) {
  const boundary = `----kobe${randomBytes(6).toString("hex")}`;
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
    `Content-Type: text/markdown\r\n\r\n# ${name}\r\n--${boundary}--\r\n`;
  const bytes = Buffer.from(body);
  return as(p).request(
    "POST",
    `/v1/projects/${project}/files`,
    new RawBody(bytes, `multipart/form-data; boundary=${boundary}`),
    { "content-length": String(bytes.length) },
  );
}

const memoryPut = (p: Person, project: string, content = "x") =>
  as(p).put(`/v1/memory?project_id=${project}`, { scope: "project", path: "notes.md", content });
const memoryList = (p: Person, project: string) =>
  as(p).get(`/v1/memory?scope=project&project_id=${project}`);

async function audits(team: string, action: string) {
  const { rows } = await f.fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
    [team, action],
  );
  return rows.map((r) => r.target);
}

const ids = (res: { json: { projects?: { id: string }[] } }) =>
  (res.json.projects ?? []).map((p) => p.id).sort();

describe("creation gate (PR4)", () => {
  it("team admins and contributors create; members cannot; the creator is owner", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    const m = await f.member(w.team);
    expect((await as(m).post("/v1/projects", { name: "No" })).status).toBe(403);
    const made = await as(c).post("/v1/projects", { name: "Mine" });
    expect(made.json).toMatchObject({ my_role: "owner", visibility: "workspace" });
    expect((await as(w.owner).post("/v1/projects", { name: "Admin's" })).status).toBe(201);
    expect((await audits(w.team, "project.created")).map((t) => t.visibility)).toEqual([
      "workspace",
      "workspace",
    ]);
  });
});

describe("the matrix, row by row (PR3, ac-1)", () => {
  it("reader views, converses and reads memory, but cannot upload, manage or remember", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    const reader = await f.member(w.team); // implicit reader of a workspace project
    const project = await create(c, { name: "Open" });
    const file = await upload(c, project.id, "a.md");
    expect(file.status).toBe(201);
    expect((await memoryPut(c, project.id)).status).toBe(200);

    expect((await as(reader).get(`/v1/projects/${project.id}`)).json.my_role).toBe("reader");
    expect((await as(reader).get(`/v1/projects/${project.id}/files`)).json.files).toHaveLength(1);
    expect((await as(reader).get(`/v1/projects/${project.id}/members`)).status).toBe(200);
    expect(ids(await as(reader).get("/v1/projects"))).toEqual([project.id]);
    // Converse: a conversation in the project.
    expect((await as(reader).post("/v1/threads", { project_id: project.id })).status).toBe(201);
    // Memory: read yes, write no (plain refusal).
    expect((await memoryList(reader, project.id)).json.docs).toHaveLength(1);
    const refused = await memoryPut(reader, project.id);
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe("read_only");
    // No edit, no manage.
    expect((await upload(reader, project.id, "b.md")).status).toBe(403);
    expect(
      (await as(reader).delete(`/v1/projects/${project.id}/files/${file.json.id}`)).status,
    ).toBe(403);
    expect((await as(reader).patch(`/v1/projects/${project.id}`, { name: "x" })).status).toBe(403);
    expect(
      (await as(reader).post(`/v1/projects/${project.id}/members`, { user_id: reader.id })).status,
    ).toBe(403);
    expect(
      (await as(reader).post(`/v1/projects/${project.id}/owner`, { user_id: reader.id })).status,
    ).toBe(403);
    // `?role=editor` leaves the project out for a reader.
    expect(ids(await as(reader).get("/v1/projects?role=editor"))).toEqual([]);
    expect((await as(reader).get("/v1/projects?role=owner")).status).toBe(400);
  });

  it("editor uploads, removes files and writes memory, but does not manage", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    const editor = await f.member(w.team);
    const project = await create(c, { name: "Work" });
    expect(
      (
        await as(c).post(`/v1/projects/${project.id}/members`, {
          user_id: editor.id,
          role: "editor",
        })
      ).status,
    ).toBe(201);
    const up = await upload(editor, project.id, "e.md");
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    expect((await as(editor).delete(`/v1/projects/${project.id}/files/${up.json.id}`)).status).toBe(
      204,
    );
    expect((await memoryPut(editor, project.id)).status).toBe(200);
    expect(ids(await as(editor).get("/v1/projects?role=editor"))).toEqual([project.id]);
    expect((await as(editor).patch(`/v1/projects/${project.id}`, { name: "x" })).status).toBe(403);
    expect(
      (await as(editor).patch(`/v1/projects/${project.id}`, { visibility: "restricted" })).status,
    ).toBe(403);
    expect(
      (await as(editor).patch(`/v1/projects/${project.id}/members/${c.id}`, { role: "reader" }))
        .status,
    ).toBe(403);
  });

  it("owner edits, changes visibility and re-roles, audited with the new role", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    const m = await f.member(w.team);
    const project = await create(c, { name: "Owned" });
    expect((await as(c).patch(`/v1/projects/${project.id}`, { name: "Renamed" })).status).toBe(200);
    expect(
      (await as(c).post(`/v1/projects/${project.id}/members`, { user_id: m.id, role: "editor" }))
        .status,
    ).toBe(201);
    const reroled = await as(c).patch(`/v1/projects/${project.id}/members/${m.id}`, {
      role: "reader",
    });
    expect(reroled.json).toMatchObject({ user_id: m.id, role: "reader" });
    expect((await upload(m, project.id, "no.md")).status).toBe(403);
    expect(
      (await as(c).patch(`/v1/projects/${project.id}`, { visibility: "restricted" })).status,
    ).toBe(200);
    expect(await audits(w.team, "project.visibility_changed")).toEqual([
      { projectId: project.id, from: "workspace", to: "restricted" },
    ]);
    expect(await audits(w.team, "project.member_role_changed")).toEqual([
      {
        projectId: project.id,
        userId: m.id,
        from: "editor",
        to: "reader",
        roles: { owner: 1, editor: 0, reader: 1 },
      },
    ]);
  });

  it("team admin does everything in a restricted project without a row", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    const m = await f.member(w.team);
    const project = await create(c, { name: "Private", visibility: "restricted" });
    const admin = w.owner;
    expect((await as(admin).get(`/v1/projects/${project.id}`)).json.my_role).toBeNull();
    expect(ids(await as(admin).get("/v1/projects?role=editor"))).toEqual([project.id]);
    const up = await upload(admin, project.id, "adm.md");
    expect(up.status).toBe(201);
    expect((await memoryPut(admin, project.id)).status).toBe(200);
    expect((await memoryList(admin, project.id)).json.docs).toHaveLength(1);
    expect((await as(admin).patch(`/v1/projects/${project.id}`, { name: "A" })).status).toBe(200);
    expect(
      (
        await as(admin).post(`/v1/projects/${project.id}/members`, {
          user_id: m.id,
          role: "reader",
        })
      ).status,
    ).toBe(201);
    expect((await as(admin).post("/v1/threads", { project_id: project.id })).status).toBe(201);
    expect((await as(admin).delete(`/v1/projects/${project.id}/files/${up.json.id}`)).status).toBe(
      204,
    );
  });

  it("restricted answers 404 to non-members everywhere", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    const listed = await f.member(w.team);
    const outsider = await f.member(w.team);
    const project = await create(c, {
      name: "Hidden",
      visibility: "restricted",
      member_user_ids: [listed.id],
    });
    expect((await upload(c, project.id, "h.md")).status).toBe(201);
    expect((await memoryPut(c, project.id)).status).toBe(200);
    // A conversation shared to the project: listed members read it, the outsider does not.
    const made = await as(c).post("/v1/threads", { title: "plan", project_id: project.id });
    const threadId = made.json.thread_id as string;
    expect((await as(c).patch(`/v1/threads/${threadId}`, { shared_to_project: true })).status).toBe(
      200,
    );
    expect((await as(listed).get(`/v1/threads/${threadId}`)).status).toBe(200);

    const o = as(outsider);
    expect(ids(await o.get("/v1/projects"))).toEqual([]);
    expect((await o.get(`/v1/projects/${project.id}`)).status).toBe(404);
    expect((await o.get(`/v1/projects/${project.id}/files`)).status).toBe(404);
    expect((await o.get(`/v1/projects/${project.id}/members`)).status).toBe(404);
    expect((await upload(outsider, project.id, "x.md")).status).toBe(404);
    const fileId = (
      (await as(c).get(`/v1/projects/${project.id}/files`)).json.files as {
        id: string;
      }[]
    )[0]?.id;
    expect((await o.delete(`/v1/projects/${project.id}/files/${fileId}`)).status).toBe(404);
    expect(
      (
        await o.post(`/v1/projects/${project.id}/files/import`, {
          source: { kind: "workspace_file", path: "notes.md" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await o.patch(`/v1/projects/${project.id}/members/${listed.id}`, { role: "reader" })).status,
    ).toBe(404);
    expect((await o.delete(`/v1/projects/${project.id}/members/${listed.id}`)).status).toBe(404);
    expect(
      (await o.post(`/v1/projects/${project.id}/owner`, { user_id: outsider.id })).status,
    ).toBe(404);
    expect((await memoryList(outsider, project.id)).status).toBe(404);
    expect((await memoryPut(outsider, project.id)).status).toBe(404);
    expect((await o.post("/v1/threads", { project_id: project.id })).status).toBe(404);
    expect((await o.get(`/v1/threads/${threadId}`)).status).toBe(404);
    expect((await o.get(`/v1/threads?project_id=${project.id}`)).json.threads).toEqual([]);
  });
});

describe("owners (PR5, ac-3)", () => {
  it("the last owner stays; an owner hands over and becomes editor", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    const m = await f.member(w.team);
    const project = await create(c, { name: "Handover" });
    expect(
      (await as(c).patch(`/v1/projects/${project.id}/members/${c.id}`, { role: "editor" })).json
        .code,
    ).toBe("last_owner");
    expect((await as(c).delete(`/v1/projects/${project.id}/members/${c.id}`)).json.code).toBe(
      "last_owner",
    );
    const moved = await as(c).post(`/v1/projects/${project.id}/owner`, { user_id: m.id });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    expect(moved.json).toEqual({
      project_id: project.id,
      owner_user_id: m.id,
      previous_owner_user_id: c.id,
    });
    const members = (await as(m).get(`/v1/projects/${project.id}/members`)).json.members as {
      user_id: string;
      role: string;
    }[];
    expect(Object.fromEntries(members.map((x) => [x.user_id, x.role]))).toEqual({
      [c.id]: "editor",
      [m.id]: "owner",
    });
    expect(await audits(w.team, "project.owner_transferred")).toEqual([
      { projectId: project.id, toUserId: m.id, fromUserId: c.id },
    ]);
    // A deactivated account cannot become owner.
    const gone = await f.member(w.team);
    await f.fx.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [gone.id]);
    const refusedGone = await as(m).post(`/v1/projects/${project.id}/owner`, { user_id: gone.id });
    expect(refusedGone.status).toBe(422);
    expect(refusedGone.json.code).toBe("invalid_input");
    // The target must be in the workspace.
    const elsewhere = await f.world();
    expect(
      (await as(m).post(`/v1/projects/${project.id}/owner`, { user_id: elsewhere.owner.id })).json
        .code,
    ).toBe("not_in_team");
  });

  it("a team admin transfers; a project whose only owner left is listed to admins as owner-less", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    const m = await f.member(w.team);
    const project = await create(c, { name: "Orphan", visibility: "restricted" });
    const other = await create(c, { name: "Kept" });
    await as(c).post(`/v1/projects/${other.id}/members`, { user_id: m.id, role: "owner" });

    expect((await as(w.owner).delete(`/v1/team/members/${c.id}`)).status).toBe(204);
    const ownerless = await as(w.owner).get("/v1/projects/no-owner");
    expect(ownerless.status).toBe(200);
    expect(ids(ownerless)).toEqual([project.id]);
    expect((await as(m).get("/v1/projects/no-owner")).status).toBe(403);
    // The project keeps running for team admins, who assign an owner (nobody is demoted).
    const assigned = await as(w.owner).post(`/v1/projects/${project.id}/owner`, { user_id: m.id });
    expect(assigned.json).toEqual({
      project_id: project.id,
      owner_user_id: m.id,
      previous_owner_user_id: null,
    });
    expect(ids(await as(w.owner).get("/v1/projects/no-owner"))).toEqual([]);
    expect((await as(m).get(`/v1/projects/${project.id}`)).json.my_role).toBe("owner");
    expect(await audits(w.team, "project.owner_transferred")).toEqual([
      { projectId: project.id, toUserId: m.id, fromUserId: null },
    ]);
  });
});

describe("run.start.project.access (PR3, CM6)", () => {
  it("is read for a reader's run and write for an editor's", async () => {
    const w = await f.world();
    const c = await contributor(w.team);
    const reader = await f.member(w.team);
    const project = await create(c, { name: "Access", instructions: "Be kind." });
    const startFor = async (p: Person) => {
      const made = await as(p).post("/v1/threads", { project_id: project.id });
      expect(made.status).toBe(201);
      const ws = await f.connect(
        { team: w.team, owner: p, target: { teamId: w.team, userId: p.id } },
        0,
        ["projects"],
      );
      const runId = await f.message(p, made.json.thread_id as string, "hello");
      const start = await ws.started(runId);
      ws.reply(start, "ok");
      await ws.acked(runId);
      return start.project;
    };
    expect(await startFor(reader)).toMatchObject({ id: project.id, access: "read" });
    expect(await startFor(c)).toMatchObject({ id: project.id, access: "write" });
  });
});
