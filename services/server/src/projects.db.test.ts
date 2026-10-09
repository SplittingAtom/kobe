import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROJECT_INSTRUCTIONS_MAX_BYTES } from "@kobe/protocol";
import { RunFixture } from "./testing/run-fixture.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-161: projects API (D23). Roles come from `projectPermissions`; non-members get 404;
 * instructions reach every run on a project thread, only for members, only for agents that
 * announce `projects`; audit events carry no instruction text.
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
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

async function create(p: Person, body: Record<string, unknown>) {
  const res = await as(p).post("/v1/projects", body);
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json as Record<string, any>;
}

describe("projects API", () => {
  it("lets Builders and admins create; members cannot; creator becomes owner", async () => {
    const w = await f.world();
    const b = await builder(w.team);
    const m = await f.member(w.team);
    expect((await as(m).post("/v1/projects", { name: "Nope" })).status).toBe(403);
    const project = await create(b, { name: "Q3 Planning & Budget", instructions: "Be brief." });
    expect(project).toMatchObject({
      slug: "q3-planning-budget",
      my_role: "owner",
      members_mode: "team",
      instructions: "Be brief.",
      file_count: 0,
    });
    const admin = await create(w.owner, { name: "Q3 Planning & Budget" });
    expect(admin.slug).toBe("q3-planning-budget-2");
    expect((await as(b).post("/v1/projects", { name: "x", slug: project.slug })).status).toBe(409);
    expect((await as(b).post("/v1/projects", { name: "x", slug: "Bad Slug" })).status).toBe(400);
    const tooLong = "é".repeat(PROJECT_INSTRUCTIONS_MAX_BYTES);
    expect((await as(b).post("/v1/projects", { name: "x", instructions: tooLong })).status).toBe(
      400,
    );
    // Default mode `team`: every team member is an implicit member.
    expect((await as(m).get(`/v1/projects/${project.id}`)).json.my_role).toBe("member");
  });

  it("hides selected-mode projects from non-members (404, not listed); admins manage all", async () => {
    const w = await f.world();
    const b = await builder(w.team);
    const inside = await f.member(w.team);
    const outside = await f.member(w.team);
    const project = await create(b, {
      name: "Secret",
      members_mode: "selected",
      member_user_ids: [inside.id],
    });
    expect((await as(inside).get(`/v1/projects/${project.id}`)).status).toBe(200);
    expect((await as(outside).get(`/v1/projects/${project.id}`)).status).toBe(404);
    expect((await as(outside).get(`/v1/projects/${project.id}/members`)).status).toBe(404);
    expect((await as(outside).patch(`/v1/projects/${project.id}`, { name: "x" })).status).toBe(404);
    expect((await as(outside).delete(`/v1/projects/${project.id}`)).status).toBe(404);
    expect((await as(outside).get("/v1/projects")).json.projects).toEqual([]);
    expect((await as(inside).get("/v1/projects")).json.projects).toHaveLength(1);
    // A team admin who is not a member sees and manages it (my_role null), another team's user does not.
    const seen = await as(w.owner).get(`/v1/projects/${project.id}`);
    expect(seen.json.my_role).toBeNull();
    expect(
      (await as(w.owner).patch(`/v1/projects/${project.id}`, { name: "Renamed" })).status,
    ).toBe(200);
    const other = await f.world();
    expect((await f.on(0, other.owner).get(`/v1/projects/${project.id}`)).status).toBe(404);
  });

  it("enforces owner vs member rules, members_mode, last owner and team membership", async () => {
    const w = await f.world();
    const b = await builder(w.team);
    const m1 = await f.member(w.team);
    const m2 = await f.member(w.team);
    const stranger = (await f.world()).owner;
    const project = await create(b, { name: "Roles" });
    const url = `/v1/projects/${project.id}`;
    // A plain member uses but does not manage.
    expect((await as(m1).patch(url, { name: "x" })).status).toBe(403);
    expect((await as(m1).delete(url)).status).toBe(403);
    expect((await as(m1).post(`${url}/members`, { user_id: m2.id })).status).toBe(403);
    expect((await as(m1).get(`${url}/members`)).status).toBe(200);
    // The owner adds members (team users only), no duplicates.
    expect((await as(b).post(`${url}/members`, { user_id: stranger.id })).status).toBe(422);
    const added = await as(b).post(`${url}/members`, { user_id: m1.id });
    expect(added.status).toBe(201);
    expect(added.json.role).toBe("member");
    expect((await as(b).post(`${url}/members`, { user_id: m1.id })).status).toBe(409);
    // Last owner stays; promote, then demote the first.
    expect((await as(b).patch(`${url}/members/${b.id}`, { role: "member" })).json.code).toBe(
      "last_owner",
    );
    expect((await as(b).delete(`${url}/members/${b.id}`)).json.code).toBe("last_owner");
    expect((await as(b).patch(`${url}/members/${m1.id}`, { role: "owner" })).status).toBe(200);
    expect((await as(m1).patch(url, { description: "by new owner" })).status).toBe(200);
    expect((await as(b).patch(`${url}/members/${b.id}`, { role: "member" })).status).toBe(200);
    // Mode team: an implicit member without a row can be promoted (gets a row).
    expect((await as(m1).patch(`${url}/members/${m2.id}`, { role: "owner" })).status).toBe(200);
    // Mode selected: only rows count; removing a row removes access.
    expect((await as(m1).patch(url, { members_mode: "selected" })).status).toBe(200);
    const third = await f.member(w.team);
    expect((await as(third).get(url)).status).toBe(404);
    expect((await as(m1).delete(`${url}/members/${randomUUID()}`)).status).toBe(404);
    expect((await as(m1).delete(`${url}/members/${b.id}`)).status).toBe(204);
    expect((await as(b).get(url)).status).toBe(404);
    const list = await as(m1).get(`${url}/members`);
    expect(list.json.members_mode).toBe("selected");
    expect(list.json.members.map((x: { user_id: string }) => x.user_id).sort()).toEqual(
      [m1.id, m2.id].sort(),
    );
  });

  it("validates the default agent and refuses delete while threads or memory exist", async () => {
    const w = await f.world();
    const b = await builder(w.team);
    const project = await create(b, { name: "Delete me" });
    const url = `/v1/projects/${project.id}`;
    expect((await as(b).patch(url, { default_agent_id: randomUUID() })).status).toBe(422);
    expect(
      (await as(b).post("/v1/projects", { name: "y", default_agent_id: randomUUID() })).status,
    ).toBe(422);
    expect((await as(b).patch(url, { default_agent_id: null })).status).toBe(200);

    const thread = await as(b).post("/v1/threads", { title: "t", project_id: project.id });
    expect(thread.status, JSON.stringify(thread.json)).toBe(201);
    const refused = await as(b).delete(url);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("project_in_use");
    expect(refused.json.message).toContain("1 threads");
    await f.fx.admin.query(`DELETE FROM threads WHERE team_id = $1 AND id = $2`, [
      w.team,
      thread.json.thread_id,
    ]);
    await f.fx.admin.query(
      `INSERT INTO memory_docs (team_id, scope, project_id, path) VALUES ($1, 'project', $2, 'a.md')`,
      [w.team, project.id],
    );
    const withMemory = await as(b).delete(url);
    expect(withMemory.status).toBe(409);
    expect(withMemory.json.message).toContain("1 memory documents");
    await f.fx.admin.query(`DELETE FROM memory_docs WHERE team_id = $1`, [w.team]);
    expect((await as(b).delete(url)).status).toBe(204);
    expect((await as(b).get(url)).status).toBe(404);
  });

  it("audits without instruction text", async () => {
    const w = await f.world();
    const b = await builder(w.team);
    const secret = "TOP-SECRET-INSTRUCTIONS";
    const project = await create(b, { name: "Audited name", instructions: secret });
    await as(b).patch(`/v1/projects/${project.id}`, {
      instructions: `${secret} 2`,
      archived: true,
    });
    const { rows } = await f.fx.admin.query<{ action: string; target: unknown }>(
      `SELECT action, target FROM audit_log WHERE team_id = $1 AND action LIKE 'project.%' ORDER BY seq`,
      [w.team],
    );
    expect(rows.map((r) => r.action)).toEqual(["project.created", "project.updated"]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("TOP-SECRET");
    expect(text).not.toContain("Audited name");
    expect(rows[1]?.target).toMatchObject({ fields: ["archived", "instructions"] });
  });
});

describe("threads in a project", () => {
  it("creates threads only for members; the default agent falls back quietly", async () => {
    const w = await f.world();
    const b = await builder(w.team);
    const outside = await f.member(w.team);
    const project = await create(b, { name: "Mine", members_mode: "selected" });
    expect((await as(outside).post("/v1/threads", { project_id: project.id })).status).toBe(404);
    expect((await as(b).post("/v1/threads", { project_id: project.id })).status).toBe(201);
    await as(b).patch(`/v1/projects/${project.id}`, { archived: true });
    expect((await as(b).post("/v1/threads", { project_id: project.id })).status).toBe(404);
  });

  it("lists and searches shared threads for members only", async () => {
    const w = await f.world();
    const b = await builder(w.team);
    const m = await f.member(w.team);
    const outside = await f.member(w.team);
    const project = await create(b, {
      name: "Shared",
      members_mode: "selected",
      member_user_ids: [m.id],
    });
    const made = await as(b).post("/v1/threads", { title: "zebra plan", project_id: project.id });
    const id = made.json.thread_id as string;
    expect((await as(m).get(`/v1/threads/${id}`)).status).toBe(404); // private until shared
    expect((await as(b).patch(`/v1/threads/${id}`, { shared_to_project: true })).status).toBe(200);
    const seen = await as(m).get(`/v1/threads?project_id=${project.id}`);
    expect(seen.json.threads.map((t: { thread_id: string }) => t.thread_id)).toEqual([id]);
    expect((await as(m).get(`/v1/threads/${id}`)).status).toBe(200);
    const found = await as(m).get("/v1/threads?q=zebra");
    expect(found.json.threads?.length ?? found.json.results?.length ?? 0).toBeGreaterThan(0);
    expect((await as(outside).get(`/v1/threads/${id}`)).status).toBe(404);
    expect((await as(outside).get(`/v1/threads?project_id=${project.id}`)).json.threads).toEqual(
      [],
    );
  });
});

describe("instructions reach project runs", () => {
  async function runStart(
    w: Awaited<ReturnType<typeof f.world>>,
    threadId: string,
    capabilities: readonly string[],
  ) {
    const ws = await f.connect(w, 0, capabilities);
    const runId = await f.message(w.owner, threadId, "hello");
    const start = await ws.started(runId);
    ws.reply(start, "ok");
    await ws.acked(runId);
    return start;
  }

  it("sends run.start.project for every run of a project thread to agents with the capability", async () => {
    const w = await f.world();
    const project = await create(w.owner, { name: "Docs", instructions: "Answer in French." });
    const made = await as(w.owner).post("/v1/threads", { project_id: project.id });
    const start = await runStart(w, made.json.thread_id, ["projects"]);
    expect(start.project).toEqual({
      id: project.id,
      slug: "docs",
      name: "Docs",
      instructions: "Answer in French.",
      mount: "/workspace/projects/docs",
    });
    // Edited instructions apply to the next run, not a snapshot of the first.
    await as(w.owner).patch(`/v1/projects/${project.id}`, { instructions: "Answer in German." });
    const ws2 = await f.connect(w, 1, ["projects"]);
    const run2 = await f.message(w.owner, made.json.thread_id, "again");
    const start2 = await ws2.started(run2);
    expect(start2.project?.instructions).toBe("Answer in German.");
  });

  it("omits it for threads without a project, agents without the capability, and non-members", async () => {
    const w = await f.world();
    const plain = await f.thread(w.owner);
    expect((await runStart(w, plain, ["projects"])).project).toBeUndefined();

    const w2 = await f.world();
    const p2 = await create(w2.owner, { name: "Old agent", instructions: "x" });
    const t2 = await as(w2.owner).post("/v1/threads", { project_id: p2.id });
    expect((await runStart(w2, t2.json.thread_id, [])).project).toBeUndefined();

    const w3 = await f.world();
    const p3 = await create(w3.owner, {
      name: "Left",
      instructions: "x",
      members_mode: "selected",
    });
    const t3 = await as(w3.owner).post("/v1/threads", { project_id: p3.id });
    await f.fx.admin.query(`DELETE FROM project_members WHERE team_id = $1`, [w3.team]);
    expect((await runStart(w3, t3.json.thread_id, ["projects"])).project).toBeUndefined();
  });
});
