import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { PINNED_AGENTS } from "./runs/agents.js";
import { RunFixture } from "./testing/run-fixture.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-76: run start gathers the resolver's inputs inside `withTeam()` and the run uses what
 * `resolveEffective` returns (model, approval mode, connectors), through a real published agent.
 */
const f = new RunFixture();
const ANY = { "if-match": "*" };

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

async function catalog(team: string, ownerId: string, enabled: [string, boolean][]) {
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
  }
  for (const [alias, isDefault] of enabled) {
    await admin.query(
      `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, $2, $3, $4)`,
      [team, alias, isDefault, ownerId],
    );
  }
}

/** Publishes a team agent with `frontmatter` and returns a thread of `p` pinned to it. */
async function pinnedThread(p: Person, frontmatter: Record<string, unknown>) {
  const b = f.on(0, p);
  const created = await b.post("/v1/agents", {
    scope: "team",
    frontmatter: { name: "Resolved", ...frontmatter },
    prompt: "You are resolved.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  const pub = await b.request("POST", `/v1/agents/${id}/publish`, {}, ANY);
  expect(pub.status, JSON.stringify(pub.json)).toBe(201);
  const thread = await b.post("/v1/threads", { agent_id: id });
  expect(thread.status, JSON.stringify(thread.json)).toBe(201);
  return thread.json.thread_id as string;
}

async function enableConnector(team: string, ownerId: string, name: string) {
  const { rows } = await f.fx.admin.query<{ id: string }>(
    `INSERT INTO connectors (name, url) VALUES ($1, 'https://mcp.example/x') RETURNING id`,
    [name],
  );
  await f.fx.admin.query(
    `INSERT INTO team_connectors (team_id, connector_id, enabled_by) VALUES ($1, $2, $3)`,
    [team, rows[0]?.id, ownerId],
  );
}

describe("run start uses the resolver (KOBE-76)", () => {
  it("ac-1: the run uses the resolved model and approval mode", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [
      ["fast", true],
      ["smart", false],
    ]);
    const ws = await f.connect(w, 0);
    const pinned = await pinnedThread(w.owner, { model: "smart", approval_mode: "ask-all" });
    const run = await f.message(w.owner, pinned, "hello");
    const start = await ws.started(run);
    expect(start.config).toMatchObject({
      model: { alias: "smart", gateway_model: "openai/smart-fake" },
      approval_mode: "ask-all",
    });
    expect((await f.run(w.team, run)).approval_mode).toBe("ask-all");
    ws.reply(start, "ok");
    await f.until(w.team, run, "completed");

    // No pin: the team default and the agent default mode (ask-on-write).
    const plain = await pinnedThread(w.owner, {});
    const second = await f.message(w.owner, plain, "again");
    const start2 = await ws.started(second);
    expect(start2.config).toMatchObject({
      model: { alias: "fast" },
      approval_mode: "ask-on-write",
    });
    ws.reply(start2, "ok");
    await f.until(w.team, second, "completed");
  });

  it("ac-2: a pinned alias the team did not enable fails the run with the agreed error", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [["fast", true]]);
    const ws = await f.connect(w, 0);
    const thread = await pinnedThread(w.owner, { model: "smart" });
    const run = await f.message(w.owner, thread, "hello");
    await f.until(w.team, run, "failed");
    expect((await f.events(w.team, run)).at(-1)?.payload).toEqual({
      error: {
        code: "agent_model_not_enabled",
        message:
          "This agent's model (smart) isn't enabled for your team. Ask your team admin to enable it.",
      },
    });
    expect(ws.starts().map((s) => s.run_id)).not.toContain(run);
  });

  it("returns omissions: a team-enabled connector the user has not connected is left out", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [["fast", true]]);
    const name = `gh-${randomBytes(3).toString("hex")}`;
    await enableConnector(w.team, w.owner.id, name);
    const thread = await pinnedThread(w.owner, { connectors: [name, "unlisted"] });
    const db = f.fx.replica(0).deps.database.db;
    const res = await withTeam(db, w.team, async (tx) => {
      const { rows } = await tx.execute<{ agent_scope: string; agent_id: string; v: number }>(
        `SELECT agent_scope, agent_id, agent_version AS v FROM threads WHERE id = '${thread}'`,
      );
      const t = rows[0];
      if (t === undefined) throw new Error("thread row missing");
      return PINNED_AGENTS.resolve(tx, {
        teamId: w.team,
        ownerUserId: w.owner.id,
        threadId: thread,
        runId: "00000000-0000-4000-8000-000000000000",
        trigger: "user",
        agentScope: t.agent_scope as "team",
        agentId: t.agent_id,
        agentVersion: t.v,
        approvalMode: "auto",
      });
    });
    expect(res.ok && res.omissions).toEqual([
      { kind: "connector", name, reason: "not_user_connected" },
      { kind: "connector", name: "unlisted", reason: "not_team_enabled" },
    ]);
    expect(res.ok && res.config?.mcp_servers).toBeUndefined();
  });
});
