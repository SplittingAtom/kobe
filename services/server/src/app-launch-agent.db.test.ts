import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITY_APP_CARDS } from "@kobe/protocol";
import { appIdOf } from "./apps/app-id.js";
import { seedGalleryAgents } from "./gallery/seed.js";
import { enableConnector, registerConnector } from "./testing/mcp-fixtures.js";
import { RunFixture, type RunWorld } from "./testing/run-fixture.js";

/**
 * KOBE-458: a thread a rail launch starts gets the agent a new conversation starts with (the
 * composer's default, gallery Kobe), so its runs offer the member's connectors, the app's own
 * included. An agentless thread can take an agent later (ac-3), checked like thread creation.
 */
const URI = "ui://c/picker";
const SHA = "a".repeat(64);
const CAPS = ["skill_bundles", CAPABILITY_APP_CARDS];
const f = new RunFixture();
let kobe = "";

beforeAll(async () => {
  await f.setup({
    appCaller: {
      call: async () => ({ ok: true, result: { content: [{ type: "text", text: "3 tables" }] } }),
    },
  });
  const [seeded] = await seedGalleryAgents(f.fx.db);
  kobe = seeded?.agentId ?? "";
  expect(kobe).not.toBe("");
});
afterAll(() => f.teardown());

async function world(): Promise<RunWorld & { readonly others: RunWorld["owner"][] }> {
  const w = await f.world(1);
  const admin = f.fx.admin;
  await admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1) ON CONFLICT (id) DO NOTHING`,
    [w.owner.id],
  );
  await admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by)
     VALUES ('fast', 'openai', 'fast-fake', $1) ON CONFLICT (alias) DO NOTHING`,
    [w.owner.id],
  );
  await admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'fast', true, $2)`,
    [w.team, w.owner.id],
  );
  return w;
}

async function app(w: RunWorld) {
  const connector = await registerConnector(f.fx.admin, {
    tools: [{ name: "open_picker", readOnly: true, ui: { resource_uri: URI } }],
  });
  await enableConnector(f.fx.admin, w.team, connector.id, w.owner.id, "all");
  await f.fx.admin.query(
    `INSERT INTO connector_ui_resources
       (connector_id, uri, mime_type, html, sha256, pinned_hash, status, approved)
     VALUES ($1, $2, 'text/html;profile=mcp-app', '<p>x</p>', $3, $3, 'pinned', true)`,
    [connector.id, URI, SHA],
  );
  return { connector, appId: appIdOf(connector.id, URI) };
}

async function threadAgent(threadId: string) {
  const { rows } = await f.fx.admin.query<{
    agent_id: string | null;
    agent_scope: string | null;
    agent_version: number | null;
  }>(`SELECT agent_id, agent_scope, agent_version FROM threads WHERE id = $1`, [threadId]);
  return rows[0];
}

async function runConnectors(runId: string): Promise<string[] | null> {
  const { rows } = await f.fx.admin.query<{ ids: string[] | null }>(
    `SELECT mcp_connector_ids AS ids FROM runs WHERE id = $1`,
    [runId],
  );
  return rows[0]?.ids ?? null;
}

const launchNew = (w: RunWorld, appId: string) =>
  w.owner.browser.post(`/v1/threads/app-cards`, { app_id: appId });

describe("an app launch starts the thread with the new-conversation agent (KOBE-458)", () => {
  it("pins the agent the runnable list marks default, recorded on the thread (ac-1)", async () => {
    const w = await world();
    const { appId } = await app(w);
    const listed = await w.owner.browser.get("/v1/agents/runnable");
    const defaults = (listed.json.agents as { id: string; default?: boolean }[]).filter(
      (a) => a.default === true,
    );
    expect(defaults.map((a) => a.id)).toEqual([kobe]);

    const res = await launchNew(w, appId);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const threadId = res.json.thread_id as string;
    expect(await threadAgent(threadId)).toMatchObject({ agent_id: kobe, agent_scope: "gallery" });
    expect((await threadAgent(threadId))?.agent_version).toBeGreaterThanOrEqual(1);
    const read = await w.owner.browser.get(`/v1/threads/${threadId}`);
    expect(read.json).toMatchObject({ agent_id: kobe, agent_name: "Kobe" });
  });

  it("offers the member's connectors, the app's own included, on the first run (ac-2)", async () => {
    const w = await world();
    const { connector, appId } = await app(w);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = (await launchNew(w, appId)).json.thread_id as string;
    const runId = await f.message(w.owner, threadId, "what is in it?");
    const start = await ws.started(runId);
    expect(start.config?.mcp_servers?.map((m) => m.connector_id)).toEqual([connector.id]);
    expect(start.app_cards).toHaveLength(1);
    ws.reply(start, "three tables");
    await expect.poll(() => f.status(w.team, runId)).toBe("completed");
    expect(await runConnectors(runId)).toEqual([connector.id]);
  });

  it("starts with no agent when the default agent is suspended for the team", async () => {
    const w = await world();
    const { appId } = await app(w);
    await f.fx.admin.query(
      `INSERT INTO team_agent_suspensions (team_id, agent_id, agent_scope, suspended_by)
       VALUES ($1, $2, 'gallery', $3)`,
      [w.team, kobe, w.owner.id],
    );
    const res = await launchNew(w, appId);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(await threadAgent(res.json.thread_id as string)).toMatchObject({ agent_id: null });
  });
});

describe("an agentless thread takes an agent later (KOBE-458 ac-3)", () => {
  it("gives later runs that agent's connectors", async () => {
    const w = await world();
    const { connector } = await app(w);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = await f.thread(w.owner);
    const first = await f.message(w.owner, threadId, "hello");
    const start = await ws.started(first);
    expect(start.config?.mcp_servers).toBeUndefined();
    ws.reply(start, "hi");
    await expect.poll(() => f.status(w.team, first)).toBe("completed");
    expect(await runConnectors(first)).toEqual([]);

    const chosen = await w.owner.browser.post(`/v1/threads/${threadId}/agent`, { agent_id: kobe });
    expect(chosen.status, JSON.stringify(chosen.json)).toBe(200);
    expect(chosen.json).toMatchObject({ agent_id: kobe });
    expect(await f.auditActions(w.team)).toContain("thread.agent_chosen");

    const next = await f.message(w.owner, threadId, "and now?");
    const again = await ws.started(next);
    expect(again.config?.mcp_servers?.map((m) => m.connector_id)).toEqual([connector.id]);
    ws.reply(again, "now with tools");
    await expect.poll(() => f.status(w.team, next)).toBe("completed");
    expect(await runConnectors(next)).toEqual([connector.id]);
  });

  it("is refused once the thread has an agent, for an agent the member can't use, and for others", async () => {
    const w = await world();
    const threadId = await f.thread(w.owner);
    const choose = (who: RunWorld["owner"], agentId: string) =>
      who.browser.post(`/v1/threads/${threadId}/agent`, { agent_id: agentId });

    // Someone else's personal agent is not the member's to use: not found, as at creation.
    const mate = w.others[0];
    if (!mate) throw new Error("no team mate");
    const theirs = await mate.browser.post("/v1/agents", {
      scope: "personal",
      frontmatter: { name: "Mine Only" },
      prompt: "x",
    });
    const theirsId = theirs.json.agent.id as string;
    const pub = await mate.browser.request(
      "POST",
      `/v1/agents/${theirsId}/publish`,
      {},
      {
        "if-match": "*",
      },
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(201);
    expect((await choose(w.owner, theirsId)).json.code).toBe("agent_not_found");
    // Not the owner: the thread is not theirs to change.
    expect((await choose(mate, kobe)).status).toBe(404);
    expect(await threadAgent(threadId)).toMatchObject({ agent_id: null });

    expect((await choose(w.owner, kobe)).status).toBe(200);
    const again = await choose(w.owner, kobe);
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("agent_already_chosen");
    const bad = await w.owner.browser.post(`/v1/threads/${threadId}/agent`, { agent_id: "x" });
    expect(bad.status).toBe(400);
  });
});
