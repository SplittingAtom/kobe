import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_CARD_CUSTOM_TYPE,
  APP_CARD_PREAMBLE,
  CAPABILITY_APP_CARDS,
  isAppCardEntryId,
} from "@kobe/protocol";
import type { AppCallRequest } from "./apps/app-caller.js";
import { appIdOf } from "./apps/app-id.js";
import { enableConnector, registerConnector } from "./testing/mcp-fixtures.js";
import { RunFixture, type RunWorld } from "./testing/run-fixture.js";

/**
 * KOBE-440 (MA-6, spec MA11): a rail launch calls the app's opening tool as the member (the MA-4
 * path, audited), stores the result and inserts an `app_card` entry at the thread's leaf, with no
 * run, no model call and no spend; from the new-thread view it starts a thread. The next run's
 * `run.start` carries the card for Pi (capability `app_cards`), so the model sees the text result
 * fenced as untrusted data opened by the member. During a run the launch waits and is inserted
 * when the run ends, before the next queued message; removing it cancels it.
 */
const URI = "ui://c/explorer";
const SHA = "e".repeat(64);
const STRUCTURED = { namespaces: ["secret-structure"] };
const calls: AppCallRequest[] = [];
let answer: Record<string, unknown> = {
  content: [{ type: "text", text: "3 namespaces: a, b, c" }],
  structuredContent: STRUCTURED,
};

const f = new RunFixture();
beforeAll(() =>
  f.setup({
    appCaller: {
      call: async (request) => {
        calls.push(request);
        return { ok: true, result: answer };
      },
    },
  }),
);
afterAll(() => f.teardown());

const CAPS = ["skill_bundles", CAPABILITY_APP_CARDS];

async function app(w: RunWorld) {
  const connector = await registerConnector(f.fx.admin, {
    tools: [{ name: "open_explorer", readOnly: true, ui: { resource_uri: URI } }],
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

async function entries(team: string, threadId: string) {
  const { rows } = await f.fx.admin.query<{
    entry_id: string;
    parent_id: string | null;
    type: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT entry_id, parent_id, type, payload FROM thread_entries
      WHERE team_id = $1 AND thread_id = $2 ORDER BY seq`,
    [team, threadId],
  );
  return rows;
}

async function leaf(threadId: string): Promise<string | null> {
  const { rows } = await f.fx.admin.query<{ leaf_entry_id: string | null }>(
    `SELECT leaf_entry_id FROM threads WHERE id = $1`,
    [threadId],
  );
  return rows[0]?.leaf_entry_id ?? null;
}

async function runCount(threadId: string): Promise<number> {
  const { rows } = await f.fx.admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM runs WHERE thread_id = $1`,
    [threadId],
  );
  return rows[0]?.n ?? 0;
}

const launch = (w: RunWorld, threadId: string, appId: string) =>
  w.owner.browser.post(`/v1/threads/${threadId}/app-cards`, { app_id: appId });

/** A thread with one answered exchange. */
async function answered(w: RunWorld, ws: Awaited<ReturnType<RunFixture["connect"]>>) {
  const threadId = await f.thread(w.owner);
  const runId = await f.message(w.owner, threadId, "hello");
  ws.reply(await ws.started(runId), "hi there");
  await expect.poll(() => f.status(w.team, runId)).toBe("completed");
  return threadId;
}

describe("rail launch inserts an app card (KOBE-440)", () => {
  it("inserts the card at the leaf with no run, no model call and no sandbox (ac-2)", async () => {
    const w = await f.world();
    const { connector, appId } = await app(w);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = await answered(w, ws);
    const before = await leaf(threadId);
    const frames = ws.sb.frames("run.start").length;
    calls.length = 0;

    const res = await launch(w, threadId, appId);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json).toMatchObject({ thread_id: threadId, queued: false });
    const entryId = res.json.entry_id as string;
    expect(isAppCardEntryId(entryId)).toBe(true);

    // The opening tool, as the member, with no arguments, through the MA-4 path (audited).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      connectorId: connector.id,
      tool: "open_explorer",
      arguments: {},
    });
    expect(await f.auditActions(w.team)).toContain("mcp.app_call");

    const card = (await entries(w.team, threadId)).at(-1);
    expect(card).toMatchObject({ entry_id: entryId, parent_id: before, type: "custom_message" });
    expect(card?.payload).toMatchObject({
      customType: APP_CARD_CUSTOM_TYPE,
      display: true,
      details: {
        connector_id: connector.id,
        app_id: appId,
        tool: "open_explorer",
        template_sha256: SHA,
        result_ref: res.json.result_ref,
        opened_by: w.owner.id,
      },
    });
    expect(await leaf(threadId)).toBe(entryId);
    expect(await runCount(threadId)).toBe(1);
    expect(ws.sb.frames("run.start")).toHaveLength(frames);

    // The viewer gets the app for it, with the stored result.
    const views = await w.owner.browser.get(`/v1/threads/${threadId}/app-results`);
    expect(views.json.results).toContainEqual(
      expect.objectContaining({ entry_id: entryId, view: "app", queued: false }),
    );
    const stored = await w.owner.browser.get(
      `/v1/threads/${threadId}/app-results/${res.json.result_ref as string}`,
    );
    expect(stored.json).toEqual({ input: {}, result: answer });
  });

  it("starts a new thread titled after the app, with the card as its first entry (ac-2)", async () => {
    const w = await f.world();
    const { appId } = await app(w);
    const res = await w.owner.browser.post(`/v1/threads/app-cards`, { app_id: appId });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const threadId = res.json.thread_id as string;
    const thread = await w.owner.browser.get(`/v1/threads/${threadId}`);
    expect(thread.json.title).toBe("open_explorer");
    const rows = await entries(w.team, threadId);
    expect(rows.map((r) => [r.entry_id, r.parent_id])).toEqual([[res.json.entry_id, null]]);
    expect(await leaf(threadId)).toBe(res.json.entry_id);
    expect(await runCount(threadId)).toBe(0);
  });

  it("gives the next run the card, fenced and untrusted, without the structured result (ac-3)", async () => {
    const w = await f.world();
    const { connector, appId } = await app(w);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = await answered(w, ws);
    const card = (await launch(w, threadId, appId)).json.entry_id as string;

    const runId = await f.message(w.owner, threadId, "what is in it?");
    const start = await ws.started(runId);
    expect(start.parent_entry_id).toBe(card);
    expect(start.app_cards).toHaveLength(1);
    const content = start.app_cards?.[0]?.content ?? "";
    expect(content.startsWith(`${APP_CARD_PREAMBLE}\n`)).toBe(true);
    expect(content).toContain(
      `<app-card source="connector:${connector.name}" tool="open_explorer" opened_by_member="true" untrusted="true">`,
    );
    expect(content).toContain("3 namespaces: a, b, c");
    expect(JSON.stringify(start)).not.toContain("secret-structure");
    expect(JSON.stringify(start)).not.toContain("<p>x</p>");

    // Pi's prompt continues from the card: the mirror keeps the tree whole.
    const { user } = ws.reply(start, "a, b and c");
    await expect.poll(() => f.status(w.team, runId)).toBe("completed");
    const rows = await entries(w.team, threadId);
    expect(rows.find((r) => r.entry_id === user)?.parent_id).toBe(card);
    expect(rows.filter((r) => r.entry_id === card)).toHaveLength(1);

    // Pi has it now: the following run carries no card.
    const next = await f.message(w.owner, threadId, "thanks");
    expect((await ws.started(next)).app_cards).toBeUndefined();
  });

  it("an agent without app_cards continues below the card (no failed run)", async () => {
    const w = await f.world();
    const { appId } = await app(w);
    const ws = await f.connect(w);
    const threadId = await answered(w, ws);
    const above = await leaf(threadId);
    await launch(w, threadId, appId);
    const runId = await f.message(w.owner, threadId, "and now?");
    const start = await ws.started(runId);
    expect(start.app_cards).toBeUndefined();
    expect(start.parent_entry_id).toBe(above);
  });

  it("queues a launch during a run and inserts it before the next queued message (ac-4)", async () => {
    const w = await f.world();
    const { appId } = await app(w);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = await f.thread(w.owner);
    const first = await f.message(w.owner, threadId, "first");
    const start = await ws.started(first);

    const res = await launch(w, threadId, appId);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json).toEqual({ thread_id: threadId, result_ref: expect.any(String), queued: true });
    const views = await w.owner.browser.get(`/v1/threads/${threadId}/app-results`);
    expect(views.json.results).toContainEqual(
      expect.objectContaining({ result_ref: res.json.result_ref, queued: true }),
    );
    expect((await entries(w.team, threadId)).some((r) => r.type === "custom_message")).toBe(false);

    const second = await f.message(w.owner, threadId, "second");
    const { assistant } = ws.reply(start, "one");
    const next = await ws.started(second);
    const card = (await entries(w.team, threadId)).find((r) => r.type === "custom_message");
    expect(card?.parent_id).toBe(assistant);
    expect(next.parent_entry_id).toBe(card?.entry_id);
    expect(next.app_cards?.map((c) => c.id)).toEqual([card?.entry_id]);
  });

  it("removing a waiting card cancels it (ac-4)", async () => {
    const w = await f.world();
    const { appId } = await app(w);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = await f.thread(w.owner);
    const first = await f.message(w.owner, threadId, "first");
    const start = await ws.started(first);
    const ref = (await launch(w, threadId, appId)).json.result_ref as string;
    const removed = await w.owner.browser.delete(`/v1/threads/${threadId}/app-cards/${ref}`);
    expect(removed.status).toBe(204);
    expect((await w.owner.browser.delete(`/v1/threads/${threadId}/app-cards/${ref}`)).status).toBe(
      404,
    );
    ws.reply(start, "one");
    await expect.poll(() => f.status(w.team, first)).toBe("completed");
    expect((await entries(w.team, threadId)).some((r) => r.type === "custom_message")).toBe(false);
  });

  it("follows its thread: a fork copies the card and its result", async () => {
    const w = await f.world();
    const { appId } = await app(w);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = await answered(w, ws);
    const card = (await launch(w, threadId, appId)).json.entry_id as string;
    const fork = await w.owner.browser.post(`/v1/threads/${threadId}/fork`, {});
    expect(fork.status, JSON.stringify(fork.json)).toBe(201);
    const forked = fork.json.thread_id as string;
    expect((await entries(w.team, forked)).map((r) => r.entry_id)).toContain(card);
    const views = await w.owner.browser.get(`/v1/threads/${forked}/app-results`);
    expect(views.json.results).toContainEqual(
      expect.objectContaining({ entry_id: card, view: "app", queued: false }),
    );
  });

  it("refuses another member's thread, an app the member does not have, and an error result", async () => {
    const w = await f.world(1);
    const { appId } = await app(w);
    const other = w.others[0];
    if (!other) throw new Error("no member");
    await f.fx.activate(other, w.team);
    const threadId = await f.thread(w.owner);
    const foreign = await other.browser.post(`/v1/threads/${threadId}/app-cards`, {
      app_id: appId,
    });
    expect(foreign.status).toBe(404);
    const missing = await launch(w, threadId, "f".repeat(64));
    expect([missing.status, missing.json.code]).toEqual([404, "app_not_available"]);
    answer = { content: [{ type: "text", text: "boom" }], isError: true };
    try {
      const failed = await launch(w, threadId, appId);
      expect([failed.status, failed.json.code]).toEqual([502, "app_open_failed"]);
      expect(await entries(w.team, threadId)).toEqual([]);
    } finally {
      answer = {
        content: [{ type: "text", text: "3 namespaces: a, b, c" }],
        structuredContent: STRUCTURED,
      };
    }
  });
});
