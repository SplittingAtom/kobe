import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITY_APP_CARDS } from "@kobe/protocol";
import { seedGalleryAgents } from "./gallery/seed.js";
import {
  pinnedApp,
  publishedAgent,
  runConnectors,
  teamModel,
  threadAgent,
} from "./testing/app-launch-fixtures.js";
import { enableConnector, registerConnector } from "./testing/mcp-fixtures.js";
import { RunFixture, type RunWorld } from "./testing/run-fixture.js";

/**
 * KOBE-458: a thread a rail launch starts gets the agent a new conversation would: the one the
 * member chose in the new-conversation view, else the composer's default (gallery Kobe), so its
 * runs offer the member's connectors, the app's own included. The view's connectors-off go with
 * it (review MEDIUM-1). Both are checked exactly as `POST /v1/threads` checks them.
 */
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
  await teamModel(f, w);
  return w;
}

const launchNew = (w: RunWorld, body: Record<string, unknown>) =>
  w.owner.browser.post(`/v1/threads/app-cards`, body);

async function threadCount(team: string): Promise<number> {
  const { rows } = await f.fx.admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM threads WHERE team_id = $1`,
    [team],
  );
  return rows[0]?.n ?? 0;
}

describe("an app launch starts the thread with the new-conversation agent (KOBE-458)", () => {
  it("pins the agent the runnable list marks default, recorded on the thread (ac-1)", async () => {
    const w = await world();
    const { appId } = await pinnedApp(f, w);
    const listed = await w.owner.browser.get("/v1/agents/runnable");
    const defaults = (listed.json.agents as { id: string; default?: boolean }[]).filter(
      (a) => a.default === true,
    );
    expect(defaults.map((a) => a.id)).toEqual([kobe]);

    const res = await launchNew(w, { app_id: appId });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const threadId = res.json.thread_id as string;
    expect(await threadAgent(f, threadId)).toMatchObject({
      agent_id: kobe,
      agent_scope: "gallery",
    });
    expect((await threadAgent(f, threadId))?.agent_version).toBeGreaterThanOrEqual(1);
    const read = await w.owner.browser.get(`/v1/threads/${threadId}`);
    expect(read.json).toMatchObject({ agent_id: kobe, agent_name: "Kobe" });
  });

  it("offers the member's connectors, the app's own included, on the first run (ac-2)", async () => {
    const w = await world();
    const { connector, appId } = await pinnedApp(f, w);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = (await launchNew(w, { app_id: appId })).json.thread_id as string;
    const runId = await f.message(w.owner, threadId, "what is in it?");
    const start = await ws.started(runId);
    expect(start.config?.mcp_servers?.map((m) => m.connector_id)).toEqual([connector.id]);
    expect(start.app_cards).toHaveLength(1);
    ws.reply(start, "three tables");
    await expect.poll(() => f.status(w.team, runId)).toBe("completed");
    expect(await runConnectors(f, runId)).toEqual([connector.id]);
  });

  it("starts with no agent when the default agent is suspended for the team", async () => {
    const w = await world();
    const { appId } = await pinnedApp(f, w);
    await f.fx.admin.query(
      `INSERT INTO team_agent_suspensions (team_id, agent_id, agent_scope, suspended_by)
       VALUES ($1, $2, 'gallery', $3)`,
      [w.team, kobe, w.owner.id],
    );
    const res = await launchNew(w, { app_id: appId });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(await threadAgent(f, res.json.thread_id as string)).toMatchObject({ agent_id: null });
  });
});

describe("the new-conversation view's choices go with the launch (KOBE-458 review MEDIUM-1)", () => {
  it("pins the agent chosen there, or none for No agent", async () => {
    const w = await world();
    const { appId } = await pinnedApp(f, w);
    const mine = await publishedAgent(w.owner, "team", "Ledger Bot");
    const chosen = await launchNew(w, { app_id: appId, agent_id: mine });
    expect(chosen.status, JSON.stringify(chosen.json)).toBe(201);
    expect(await threadAgent(f, chosen.json.thread_id as string)).toMatchObject({
      agent_id: mine,
      agent_scope: "team",
    });
    const none = await launchNew(w, { app_id: appId, agent_id: null });
    expect(none.status, JSON.stringify(none.json)).toBe(201);
    expect(await threadAgent(f, none.json.thread_id as string)).toMatchObject({ agent_id: null });
  });

  it("refuses an agent the member can't start threads with, before the app is called", async () => {
    const w = await world();
    const { appId } = await pinnedApp(f, w);
    const mate = w.others[0];
    if (!mate) throw new Error("no team mate");
    const theirs = await publishedAgent(mate, "personal", "Mine Only");
    const draft = await publishedAgent(w.owner, "team", "Unpublished", false);
    const before = await threadCount(w.team);
    const res = await launchNew(w, { app_id: appId, agent_id: theirs });
    expect([res.status, res.json.code]).toEqual([404, "agent_not_found"]);
    const unpublished = await launchNew(w, { app_id: appId, agent_id: draft });
    expect([unpublished.status, unpublished.json.code]).toEqual([409, "agent_unavailable"]);
    expect(await threadCount(w.team)).toBe(before);
  });

  it("writes the view's connectors off with the thread, so the first run goes without them", async () => {
    const w = await world();
    const { connector, appId } = await pinnedApp(f, w);
    const other = await registerConnector(f.fx.admin, { authKind: "none" });
    await enableConnector(f.fx.admin, w.team, other.id, w.owner.id, "read_only");
    const ws = await f.connect(w, 0, CAPS);
    const res = await launchNew(w, { app_id: appId, connectors_off: [other.id] });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const threadId = res.json.thread_id as string;
    const listed = await w.owner.browser.get(`/v1/threads/${threadId}/connectors`);
    expect(
      (listed.json.connectors as { connector_id: string; enabled: boolean }[]).find(
        (c) => c.connector_id === other.id,
      ),
    ).toMatchObject({ enabled: false });
    const runId = await f.message(w.owner, threadId, "and?");
    const start = await ws.started(runId);
    expect(start.config?.mcp_servers?.map((m) => m.connector_id)).toEqual([connector.id]);
    ws.reply(start, "ok");
    await expect.poll(() => f.status(w.team, runId)).toBe("completed");
    expect(await runConnectors(f, runId)).toEqual([connector.id]);
  });

  it("refuses the app's own connector off, an unknown one, or a malformed list", async () => {
    const w = await world();
    const { connector, appId } = await pinnedApp(f, w);
    const before = await threadCount(w.team);
    const own = await launchNew(w, { app_id: appId, connectors_off: [connector.id] });
    expect([own.status, own.json.code]).toEqual([409, "connector_off"]);
    const unknown = await launchNew(w, { app_id: appId, connectors_off: [randomUUID()] });
    expect([unknown.status, unknown.json.code]).toEqual([422, "connector_not_found"]);
    const dup = await launchNew(w, { app_id: appId, connectors_off: [connector.id, connector.id] });
    expect(dup.status).toBe(400);
    expect(await threadCount(w.team)).toBe(before);
  });

  it("takes neither on a launch into an existing thread", async () => {
    const w = await world();
    const { appId } = await pinnedApp(f, w);
    const threadId = await f.thread(w.owner);
    const res = await w.owner.browser.post(`/v1/threads/${threadId}/app-cards`, {
      app_id: appId,
      agent_id: kobe,
    });
    expect(res.status).toBe(400);
  });
});
