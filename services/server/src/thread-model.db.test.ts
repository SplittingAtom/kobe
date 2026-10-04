import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PINNED_AGENTS } from "./runs/agents.js";
import { RunFixture } from "./testing/run-fixture.js";

/**
 * KOBE-44: a thread's model choice (D30, KOBE-41's open question). The owner picks one of the
 * team's enabled models for the thread (`POST /v1/threads {model}`, `PATCH /v1/threads/{id}
 * {model}`); it is the run's requested alias, so KOBE-41's resolution uses it, and a model the team
 * disabled later fails the run `agent_model_not_enabled` (no silent fallback).
 */
const f = new RunFixture();
/** Threads whose (fake) agent pins a model alias, as KOBE-47's resolver will. */
const pinnedAliases = new Map<string, string>();

beforeAll(async () => {
  await f.setup({
    agents: {
      async resolve(tx, input) {
        const resolved = await PINNED_AGENTS.resolve(tx, input);
        const alias = pinnedAliases.get(input.threadId);
        return resolved.ok && alias !== undefined
          ? { ...resolved, config: { model: { alias } } }
          : resolved;
      },
    },
  });
});

afterAll(async () => {
  await f.teardown();
});

/** Two catalog models (`fast` default, `smart`), both enabled for the team. */
async function catalog(team: string, ownerId: string, enabled: readonly string[]) {
  const admin = f.fx.admin;
  for (const [id, kind] of [
    ["openai", "openai"],
    ["anthropic", "anthropic"],
  ] as const) {
    await admin.query(
      `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
       VALUES ($1, $2, $1, 'v2.test.sealed-provider-key', $3) ON CONFLICT (id) DO NOTHING`,
      [id, kind, ownerId],
    );
  }
  for (const [alias, provider, model] of [
    ["fast", "openai", "gpt-fake"],
    ["smart", "anthropic", "claude-fake"],
  ] as const) {
    await admin.query(
      `INSERT INTO model_catalog (alias, provider_id, model, created_by)
       VALUES ($1, $2, $3, $4) ON CONFLICT (alias) DO NOTHING`,
      [alias, provider, model, ownerId],
    );
  }
  for (const alias of enabled) {
    await admin.query(
      `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, $2, $3, $4)`,
      [team, alias, alias === "fast", ownerId],
    );
  }
}

const disable = (team: string, alias: string) =>
  f.fx.admin.query(`DELETE FROM team_models WHERE team_id = $1 AND alias = $2`, [team, alias]);

describe("thread model choice (D30)", () => {
  it("is stored on the thread, shown in reads, and limited to the team's enabled models", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, ["fast", "smart"]);
    const owner = f.on(0, w.owner);

    const created = await owner.post("/v1/threads", { title: "t", model: "smart" });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json.model).toBe("smart");
    const id = created.json.thread_id as string;
    expect((await owner.get(`/v1/threads/${id}`)).json.model).toBe("smart");
    const listed = await owner.get("/v1/threads");
    expect(listed.json.threads).toEqual([
      expect.objectContaining({ thread_id: id, model: "smart" }),
    ]);
    const searched = await owner.get("/v1/threads?q=t");
    expect(searched.status).toBe(200);

    // Back to the team default, then another enabled model.
    const cleared = await owner.patch(`/v1/threads/${id}`, { model: null });
    expect(cleared.status).toBe(200);
    expect(cleared.json.model).toBeNull();
    expect((await owner.patch(`/v1/threads/${id}`, { model: "fast" })).json.model).toBe("fast");
    const changes = await f.fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'thread.model_changed' ORDER BY seq`,
      [w.team],
    );
    expect(changes.rows.map((r) => r.target)).toEqual([
      { threadId: id, from: "smart", to: null },
      { threadId: id, from: null, to: "fast" },
    ]);

    // Not in the catalog, or in it but not enabled for the team: refused, nothing changed.
    await disable(w.team, "smart");
    for (const model of ["smart", "not-in-catalog"]) {
      const res = await owner.patch(`/v1/threads/${id}`, { model });
      expect(res.status, model).toBe(409);
      expect(res.json.code).toBe("model_not_enabled");
      const create = await owner.post("/v1/threads", { title: "x", model });
      expect(create.status, model).toBe(409);
    }
    expect((await owner.get(`/v1/threads/${id}`)).json.model).toBe("fast");

    // Malformed aliases are a 400 (the pattern the catalog uses).
    expect((await owner.patch(`/v1/threads/${id}`, { model: "Bad Alias" })).status).toBe(400);
    expect((await owner.patch(`/v1/threads/${id}`, { model: 7 })).status).toBe(400);
  });

  it("only the owner chooses; another member and another team can't see or change it", async () => {
    const w = await f.world(1);
    await catalog(w.team, w.owner.id, ["fast", "smart"]);
    const id = await f.thread(w.owner);
    const teammate = await f.member(w.team);
    const res = await f.on(0, teammate).patch(`/v1/threads/${id}`, { model: "smart" });
    expect(res.status).toBe(404);
    const other = await f.world();
    const outsider = await f.on(0, other.owner).patch(`/v1/threads/${id}`, { model: "smart" });
    expect(outsider.status).toBe(404);
    // An alias another team enabled is not this team's: refused here.
    await catalog(other.team, other.owner.id, []);
    const theirs = await f.on(0, other.owner).post("/v1/threads", { model: "smart" });
    expect(theirs.status).toBe(409);
  });

  it("is the run's model: run.start carries it, ahead of the agent's pin and the team default", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, ["fast", "smart"]);
    const ws = await f.connect(w, 0);
    const id = await f.thread(w.owner);
    pinnedAliases.set(id, "fast");
    await f.on(0, w.owner).patch(`/v1/threads/${id}`, { model: "smart" });
    const runId = await f.message(w.owner, id, "hello");
    const start = await ws.started(runId);
    expect(start.config).toMatchObject({
      model: { alias: "smart", gateway_model: "anthropic/claude-fake", api: "anthropic-messages" },
    });
    expect((await f.events(w.team, runId))[0]).toMatchObject({
      type: "run.started",
      payload: { model: "smart" },
    });
    ws.reply(start, "hi");
    await f.until(w.team, runId, "completed");

    // Cleared: the agent's pin applies again.
    await f.on(0, w.owner).patch(`/v1/threads/${id}`, { model: null });
    const second = await f.message(w.owner, id, "again");
    const next = await ws.started(second);
    expect(next.config).toMatchObject({ model: { alias: "fast" } });
    ws.reply(next, "ok");
    await f.until(w.team, second, "completed");
  });

  it("a model the team disabled after it was chosen fails the run clearly, waking nothing", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, ["fast", "smart"]);
    const ws = await f.connect(w, 0);
    const owner = f.on(0, w.owner);
    const id = (await owner.post("/v1/threads", { model: "smart" })).json.thread_id as string;
    await disable(w.team, "smart");
    // The choice stays on the thread (the picker shows it as unavailable).
    expect((await owner.get(`/v1/threads/${id}`)).json.model).toBe("smart");
    const runId = await f.message(w.owner, id, "hello");
    await f.until(w.team, runId, "failed");
    expect(await f.types(w.team, runId)).toEqual(["run.failed"]);
    expect((await f.events(w.team, runId)).at(-1)?.payload).toEqual({
      error: {
        code: "agent_model_not_enabled",
        message:
          "The model chosen for this conversation (smart) isn't enabled for your team any more. Pick another model, or ask your team admin to enable it.",
      },
    });
    expect(ws.starts().map((s) => s.run_id)).not.toContain(runId);
    expect(await f.threadStatus(w.team, id)).toBe("idle");

    // Picking an enabled model makes the next message run on it.
    expect((await owner.patch(`/v1/threads/${id}`, { model: "fast" })).status).toBe(200);
    const second = await f.message(w.owner, id, "again");
    const start = await ws.started(second);
    expect(start.config).toMatchObject({ model: { alias: "fast" } });
    ws.reply(start, "ok");
    await f.until(w.team, second, "completed");
  });
});
