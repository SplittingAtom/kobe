import { randomBytes } from "node:crypto";
import { SYSTEM_PROMPT_MAX_BYTES } from "@kobe/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunFixture } from "./testing/run-fixture.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-85: the builder's test pane chats with the unpublished draft through the normal run start
 * (resolver, approval floor, budgets), on threads flagged `is_test` that stay out of lists,
 * search, Trash and the inventory's usage.
 */
const f = new RunFixture();
const ANY = { "if-match": "*" };

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

async function catalog(team: string, ownerId: string) {
  const admin = f.fx.admin;
  await admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1) ON CONFLICT (id) DO NOTHING`,
    [ownerId],
  );
  for (const alias of ["fast", "smart"]) {
    await admin.query(
      `INSERT INTO model_catalog (alias, provider_id, model, created_by)
       VALUES ($1, 'openai', $2, $3) ON CONFLICT (alias) DO NOTHING`,
      [alias, `${alias}-fake`, ownerId],
    );
    await admin.query(
      `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, $2, $3, $4)`,
      [team, alias, alias === "fast", ownerId],
    );
  }
}

async function draftAgent(p: Person, frontmatter: Record<string, unknown>, prompt = "Draft one.") {
  const res = await f.on(0, p).post("/v1/agents", {
    scope: "team",
    frontmatter: { name: `Test ${randomBytes(2).toString("hex")}`, ...frontmatter },
    prompt,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.agent.id as string;
}

async function editDraft(
  p: Person,
  id: string,
  frontmatter: Record<string, unknown>,
  prompt: string,
) {
  const res = await f.on(0, p).request("PUT", `/v1/agents/${id}`, { frontmatter, prompt }, ANY);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

async function testThread(p: Person, agentId: string) {
  const res = await f.on(0, p).post("/v1/threads", { agent_id: agentId, test: true });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json as { thread_id: string; is_test: boolean; agent_version: number | null };
}

describe("builder test pane (KOBE-85)", () => {
  it("ac-1: a test thread on a never-published draft runs the draft, and follows edits", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id);
    const ws = await f.connect(w, 0);
    const id = await draftAgent(w.owner, { model: "smart", approval_mode: "ask-all" }, "Be terse.");
    const thread = await testThread(w.owner, id);
    expect(thread).toMatchObject({ is_test: true, agent_version: null });

    const run = await f.message(w.owner, thread.thread_id, "hello");
    const start = await ws.started(run);
    expect(start.config).toMatchObject({
      model: { alias: "smart", gateway_model: "openai/smart-fake" },
      approval_mode: "ask-all",
      system_prompt: "Be terse.",
    });
    expect(start.config?.agent ?? null).toBeNull();
    // The record shows which draft ran: no version, the draft's revision.
    expect(
      (await f.events(w.team, run)).find((e) => e.type === "run.started")?.payload,
    ).toMatchObject({
      agent_id: id,
      agent_version: null,
      draft_revision: 1,
    });
    expect((await f.run(w.team, run)).approval_mode).toBe("ask-all");
    ws.reply(start, "ok");
    await f.until(w.team, run, "completed");

    // The next run reads the draft as it is now.
    const current = (await f.on(0, w.owner).get(`/v1/agents/${id}`)).json.agent;
    await editDraft(
      w.owner,
      id,
      { ...current.frontmatter, model: "fast", approval_mode: "ask-on-write" },
      "Be chatty.",
    );
    const second = await f.message(w.owner, thread.thread_id, "again");
    const start2 = await ws.started(second);
    expect(start2.config).toMatchObject({
      model: { alias: "fast" },
      approval_mode: "ask-on-write",
      system_prompt: "Be chatty.",
    });
    ws.reply(start2, "ok");
    await f.until(w.team, second, "completed");
  });

  it("a test thread beats the published version; normal threads keep theirs", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id);
    const ws = await f.connect(w, 0);
    const id = await draftAgent(w.owner, { model: "smart" }, "Published.");
    const pub = await f.on(0, w.owner).request("POST", `/v1/agents/${id}/publish`, {}, ANY);
    expect(pub.status, JSON.stringify(pub.json)).toBe(201);
    const current = (await f.on(0, w.owner).get(`/v1/agents/${id}`)).json.agent;
    await editDraft(w.owner, id, { ...current.frontmatter, model: "fast" }, "Draft.");

    const normal = await f.on(0, w.owner).post("/v1/threads", { agent_id: id });
    expect(normal.json).toMatchObject({ is_test: false, agent_version: 1 });
    const test = await testThread(w.owner, id);
    const r1 = await f.message(w.owner, normal.json.thread_id as string, "a");
    const s1 = await ws.started(r1);
    expect(s1.config).toMatchObject({ model: { alias: "smart" }, system_prompt: "Published." });
    ws.reply(s1, "ok");
    await f.until(w.team, r1, "completed");
    const r2 = await f.message(w.owner, test.thread_id, "b");
    const s2 = await ws.started(r2);
    expect(s2.config).toMatchObject({ model: { alias: "fast" }, system_prompt: "Draft." });
    ws.reply(s2, "ok");
    await f.until(w.team, r2, "completed");
  });

  it("refuses a draft the team has not enabled the model for, like any run", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id);
    await f.fx.admin.query(`DELETE FROM team_models WHERE team_id = $1 AND alias = 'smart'`, [
      w.team,
    ]);
    const id = await draftAgent(w.owner, { model: "smart" });
    const thread = await testThread(w.owner, id);
    const run = await f.message(w.owner, thread.thread_id, "hello");
    await f.until(w.team, run, "failed");
    expect((await f.events(w.team, run)).at(-1)?.payload).toMatchObject({
      error: { code: "agent_model_not_enabled" },
    });
  });

  it("a demoted creator can't start another draft run from an existing test thread", async () => {
    const w = await f.world(1);
    const builder = w.others[0] as Person;
    await f.fx.activate(builder, w.team);
    await f.fx.admin.query(
      `UPDATE team_members SET role = 'team_admin' WHERE team_id = $1 AND user_id = $2`,
      [w.team, builder.id],
    );
    await catalog(w.team, w.owner.id);
    const ws = await f.connect(
      { ...w, owner: builder, target: { teamId: w.team, userId: builder.id } },
      0,
    );
    const id = await draftAgent(builder, {});
    const thread = await testThread(builder, id);
    const first = await f.message(builder, thread.thread_id, "ok now");
    ws.reply(await ws.started(first), "ok");
    await f.until(w.team, first, "completed");

    await f.fx.admin.query(
      `UPDATE team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2`,
      [w.team, builder.id],
    );
    const second = await f.message(builder, thread.thread_id, "after demotion");
    await f.until(w.team, second, "failed");
    expect((await f.events(w.team, second)).at(-1)?.payload).toMatchObject({
      error: { code: "agent_unavailable" },
    });
    expect(ws.starts().map((s) => s.run_id)).not.toContain(second);
  });

  it("an archived agent's draft can't run", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id);
    const id = await draftAgent(w.owner, {});
    const b = f.on(0, w.owner);
    expect((await b.request("POST", `/v1/agents/${id}/publish`, {}, ANY)).status).toBe(201);
    const thread = await testThread(w.owner, id);
    expect((await b.delete(`/v1/agents/${id}`)).status).toBe(200);
    const run = await f.message(w.owner, thread.thread_id, "hello");
    await f.until(w.team, run, "failed");
    expect((await f.events(w.team, run)).at(-1)?.payload).toMatchObject({
      error: { code: "agent_unavailable" },
    });
  });

  it("a prompt at the agent-file limit reaches the sandbox whole", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id);
    const ws = await f.connect(w, 0);
    const prompt = "p".repeat(SYSTEM_PROMPT_MAX_BYTES);
    const id = await draftAgent(w.owner, {}, prompt);
    const thread = await testThread(w.owner, id);
    const run = await f.message(w.owner, thread.thread_id, "hi");
    const start = await ws.started(run);
    expect(start.config?.system_prompt).toHaveLength(SYSTEM_PROMPT_MAX_BYTES);
    ws.reply(start, "ok");
    await f.until(w.team, run, "completed");
  });

  it("only someone who can edit the agent may test it; the body is checked", async () => {
    const w = await f.world();
    const member = await f.member(w.team);
    const id = await draftAgent(w.owner, {});
    const denied = await f.on(0, member).post("/v1/threads", { agent_id: id, test: true });
    expect(denied.status).toBe(404);
    const noAgent = await f.on(0, w.owner).post("/v1/threads", { test: true });
    expect(noAgent.status).toBe(400);
    const gone = await f.on(0, w.owner).post("/v1/threads", {
      agent_id: "00000000-0000-4000-8000-000000000001",
      test: true,
    });
    expect(gone.status).toBe(404);
  });

  it("ac-2: test threads stay out of lists, search, Trash and sharing", async () => {
    const w = await f.world();
    const id = await draftAgent(w.owner, {});
    const b = f.on(0, w.owner);
    const keep = await b.post("/v1/threads", { title: "plain zebrafish" });
    const test = await b.post("/v1/threads", {
      agent_id: id,
      test: true,
      title: "zebrafish test",
    });
    expect(test.status, JSON.stringify(test.json)).toBe(201);
    const tid = test.json.thread_id as string;

    const list = await b.get("/v1/threads");
    const ids = (list.json.threads as { thread_id: string }[]).map((t) => t.thread_id);
    expect(ids).toContain(keep.json.thread_id);
    expect(ids).not.toContain(tid);

    const hits = await b.get("/v1/threads?q=zebrafish");
    expect((hits.json.threads as { thread_id: string }[]).map((t) => t.thread_id)).toEqual([
      keep.json.thread_id,
    ]);

    // Readable by id (the pane reloads it) but cannot be shared; not in Trash.
    expect((await b.get(`/v1/threads/${tid}`)).status).toBe(200);
    const share = await b.request("PATCH", `/v1/threads/${tid}`, { shared_to_project: true });
    expect(share.status).toBe(409);
    expect((await b.request("DELETE", `/v1/threads/${tid}`)).status).toBe(200);
    const trash = await b.get("/v1/threads/trash");
    expect(trash.json.threads).toEqual([]);
  });

  it("the creator clears their test threads of one agent, no one else's", async () => {
    const w = await f.world(1);
    const other = w.others[0] as Person;
    await f.fx.activate(other, w.team);
    const a = await draftAgent(w.owner, {});
    const c = await draftAgent(w.owner, {});
    const b = f.on(0, w.owner);
    const t1 = await testThread(w.owner, a);
    const t2 = await testThread(w.owner, a);
    const t3 = await testThread(w.owner, c);
    const plain = await b.post("/v1/threads", { agent_id: null, title: "plain" });

    const res = await b.request("DELETE", `/v1/threads/test?agent_id=${a}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({ cleared: 2 });
    const rows = await f.fx.admin.query<{ id: string; deleted: boolean }>(
      `SELECT id, deleted_at IS NOT NULL AS deleted FROM threads WHERE team_id = $1`,
      [w.team],
    );
    const deleted = new Set(rows.rows.filter((r) => r.deleted).map((r) => r.id));
    expect(deleted).toEqual(new Set([t1.thread_id, t2.thread_id]));
    expect(deleted.has(t3.thread_id)).toBe(false);
    expect(deleted.has(plain.json.thread_id as string)).toBe(false);

    // Clearing everything for the person; a bad id is a 400.
    expect((await b.request("DELETE", "/v1/threads/test")).json).toEqual({ cleared: 1 });
    expect((await b.request("DELETE", "/v1/threads/test?agent_id=nope")).status).toBe(400);
  });

  it("test runs do not make an agent 'used' in the inventory", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id);
    const ws = await f.connect(w, 0);
    const id = await draftAgent(w.owner, {});
    const thread = await testThread(w.owner, id);
    const run = await f.message(w.owner, thread.thread_id, "hi");
    ws.reply(await ws.started(run), "ok");
    await f.until(w.team, run, "completed");
    const inv = await f.on(0, w.owner).get("/v1/agents/inventory");
    expect(inv.status, JSON.stringify(inv.json)).toBe(200);
    const row = (inv.json.agents as { id: string; runCount: number }[]).find((a) => a.id === id);
    expect(row?.runCount).toBe(0);
  });
});
