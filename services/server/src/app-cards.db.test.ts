import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_CARD_CUSTOM_TYPE,
  appCardContent,
  appCardEntryId,
  APP_CARD_PREAMBLE,
  CAPABILITY_APP_CARDS,
  isAppCardEntryId,
} from "@kobe/protocol";
import type { AppCallRequest } from "./apps/app-caller.js";
import { appIdOf } from "./apps/app-id.js";
import { enableConnector, registerConnector } from "./testing/mcp-fixtures.js";
import { logger } from "./logger.js";
import { sweepRuns } from "./runs/sweeper.js";
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
    stopGraceMs: 3_000,
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
    expect(thread.json.title).toBe("Open explorer");
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

/** A card entry written straight into the thread (as a launch would) at the leaf. */
async function rawCard(w: RunWorld, threadId: string, appId: string, connectorId: string) {
  const id = appCardEntryId(randomUUID());
  const parent = await leaf(threadId);
  const payload = {
    type: "custom_message",
    id,
    parentId: parent,
    timestamp: new Date().toISOString(),
    customType: APP_CARD_CUSTOM_TYPE,
    content: appCardContent({ connectorName: "c", tool: "open_explorer", text: "x" }),
    display: true,
    details: {
      connector_id: connectorId,
      app_id: appId,
      tool: "open_explorer",
      template_sha256: SHA,
      result_ref: randomUUID(),
      opened_by: w.owner.id,
    },
  };
  await f.fx.admin.query(
    `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
     VALUES ($1, $2, $3, $4, 'custom_message', $5)`,
    [w.team, threadId, id, parent, JSON.stringify(payload)],
  );
  await f.fx.admin.query(`UPDATE threads SET leaf_entry_id = $2 WHERE id = $1`, [threadId, id]);
  return id;
}

async function dropped(team: string) {
  const { rows } = await f.fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'mcp.app_card_dropped' ORDER BY seq`,
    [team],
  );
  return rows.map((r) => r.target.reason);
}

/** The next run starts and completes: the thread can still run. */
async function stillRuns(
  w: RunWorld,
  ws: Awaited<ReturnType<RunFixture["connect"]>>,
  threadId: string,
) {
  const runId = await f.message(w.owner, threadId, "and now?");
  const start = await ws.started(runId);
  ws.reply(start, "fine");
  await f.until(w.team, runId, "completed");
  return start;
}

describe("no app card leaves a thread unable to run (KOBE-440 review)", () => {
  it("fits any result into the card, inserted or queued: < and invisible characters (MEDIUM-1)", async () => {
    const w = await f.world();
    const { appId } = await app(w);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = await answered(w, ws);
    answer = { content: [{ type: "text", text: `${"<".repeat(8192)}${"​".repeat(3000)}` }] };
    try {
      expect((await launch(w, threadId, appId)).status).toBe(201);
      const start = await stillRuns(w, ws, threadId);
      expect(start.app_cards?.[0]?.content.length).toBeLessThanOrEqual(16 * 1024);
      expect(start.app_cards?.[0]?.content).toContain("[truncated]");
      // Queued during a run: a 201, never a 500, and inserted at the run's end.
      const runId = await f.message(w.owner, threadId, "busy");
      const busy = await ws.started(runId);
      const queued = await launch(w, threadId, appId);
      expect([queued.status, queued.json.queued]).toEqual([201, true]);
      ws.reply(busy, "done");
      await f.until(w.team, runId, "completed");
      await stillRuns(w, ws, threadId);
    } finally {
      answer = {
        content: [{ type: "text", text: "3 namespaces: a, b, c" }],
        structuredContent: STRUCTURED,
      };
    }
  });

  it("never hangs a card under an unsent prompt; the next run starts (MEDIUM-2)", async () => {
    const w = await f.world();
    const { appId } = await app(w);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = await answered(w, ws);
    const known = await leaf(threadId);
    const own = ws.sb.respond;
    ws.sb.respond = (frame) =>
      frame.type === "run.start"
        ? {
            v: 1,
            type: "command.result",
            command_id: frame.command_id,
            ok: false,
            error: { code: "model_not_configured", message: "no model" },
          }
        : own?.(frame);
    const failed = await f.message(w.owner, threadId, "never reaches Pi");
    await f.until(w.team, failed, "failed");
    await expect.poll(() => leaf(threadId)).toMatch(/^ku-/);
    ws.sb.respond = own;

    const card = (await launch(w, threadId, appId)).json.entry_id as string;
    const row = (await entries(w.team, threadId)).find((r) => r.entry_id === card);
    expect(row?.parent_id).toBe(known);
    const start = await stillRuns(w, ws, threadId);
    expect(start.app_cards?.map((c) => [c.id, c.parentId])).toEqual([[card, known]]);
  });

  it("caps cards in a row at 20: the 21st launch is refused and the 20 still run (LOW-1)", async () => {
    const w = await f.world();
    const { connector, appId } = await app(w);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = await answered(w, ws);
    for (let i = 0; i < 20; i += 1) await rawCard(w, threadId, appId, connector.id);
    const refused = await launch(w, threadId, appId);
    expect([refused.status, refused.json.code]).toEqual([409, "too_many_cards"]);
    const start = await stillRuns(w, ws, threadId);
    expect(start.app_cards).toHaveLength(20);
  });

  it("drops a waiting card that would make too many in a row, and still runs (LOW-1)", async () => {
    const w = await f.world();
    const { connector, appId } = await app(w);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = await answered(w, ws);
    for (let i = 0; i < 19; i += 1) await rawCard(w, threadId, appId, connector.id);
    // A run that never reaches Pi (its start goes unanswered): its prompt stays the server's.
    const own = ws.sb.respond;
    ws.sb.respond = (frame) => (frame.type === "run.start" ? null : own?.(frame));
    const lost = await f.message(w.owner, threadId, "lost");
    await ws.started(lost);
    expect((await launch(w, threadId, appId)).json.queued).toBe(true);
    expect((await launch(w, threadId, appId)).json.queued).toBe(true);
    await f.until(w.team, lost, "failed", 20_000);
    ws.sb.respond = own;
    // The lost start asked Pi to abort: the cards wait out Stop's grace (LOW-R2).
    await new Promise((r) => setTimeout(r, 3_200));
    const start = await stillRuns(w, ws, threadId);
    await expect.poll(() => dropped(w.team)).toEqual(["too_many_cards"]);
    expect(start.app_cards).toHaveLength(20);
  }, 40_000);
});

describe("waiting cards are re-checked when they go in (KOBE-440 review LOW-2)", () => {
  it("drops a card whose app the member lost, and one that waited over 10 minutes", async () => {
    const w = await f.world();
    const { connector, appId } = await app(w);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = await f.thread(w.owner);
    const busy = await f.message(w.owner, threadId, "busy");
    const start = await ws.started(busy);
    const first = (await launch(w, threadId, appId)).json.result_ref as string;
    expect((await launch(w, threadId, appId)).json.queued).toBe(true);
    await f.fx.admin.query(
      `UPDATE thread_app_results SET queued_at = now() - interval '11 minutes' WHERE id = $1`,
      [first],
    );
    await f.fx.admin.query(`DELETE FROM team_connectors WHERE team_id = $1 AND connector_id = $2`, [
      w.team,
      connector.id,
    ]);
    ws.reply(start, "done");
    await f.until(w.team, busy, "completed");
    await expect.poll(() => dropped(w.team)).toEqual(["expired", "no_access"]);
    expect((await entries(w.team, threadId)).some((r) => r.type === "custom_message")).toBe(false);
    const { rows } = await f.fx.admin.query(
      `SELECT 1 FROM thread_app_results WHERE thread_id = $1`,
      [threadId],
    );
    expect(rows).toEqual([]);
  });

  it("inserts a card left waiting with no run to end before the next launch's card", async () => {
    const w = await f.world();
    const { appId } = await app(w);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = await f.thread(w.owner);
    const busy = await f.message(w.owner, threadId, "busy");
    await ws.started(busy);
    const waiting = (await launch(w, threadId, appId)).json.result_ref as string;
    // The run ends without a promotion (a crashed replica): the card is still waiting.
    await f.fx.admin.query(`UPDATE runs SET status = 'failed', ended_at = now() WHERE id = $1`, [
      busy,
    ]);
    const next = await launch(w, threadId, appId);
    expect(next.json.queued).toBe(false);
    const cards = (await entries(w.team, threadId)).filter((r) => r.type === "custom_message");
    expect(cards.map((c) => (c.payload.details as { result_ref: string }).result_ref)).toEqual([
      waiting,
      next.json.result_ref,
    ]);
    expect(cards[1]?.parent_id).toBe(cards[0]?.entry_id);
  });
});

describe("launch limits and access (KOBE-440 review LOW-3, LOW-6)", () => {
  it("rate-limits launches per member, new threads included", async () => {
    const w = await f.world();
    const { appId } = await app(w);
    const answers: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      answers.push((await w.owner.browser.post(`/v1/threads/app-cards`, { app_id: appId })).status);
    }
    expect(answers).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it("refuses another team's thread, another member's queued card, and a builder test thread", async () => {
    const w = await f.world(1);
    const other = await f.world();
    const { appId } = await app(w);
    await app(other);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = await f.thread(w.owner);
    const busy = await f.message(w.owner, threadId, "busy");
    await ws.started(busy);
    const ref = (await launch(w, threadId, appId)).json.result_ref as string;
    // Team B's member, with team B active, names team A's thread.
    const cross = await other.owner.browser.post(`/v1/threads/${threadId}/app-cards`, {
      app_id: appId,
    });
    expect(cross.status).toBe(404);
    expect(
      (await other.owner.browser.delete(`/v1/threads/${threadId}/app-cards/${ref}`)).status,
    ).toBe(404);
    const member = w.others[0];
    if (!member) throw new Error("no member");
    await f.fx.activate(member, w.team);
    expect((await member.browser.delete(`/v1/threads/${threadId}/app-cards/${ref}`)).status).toBe(
      404,
    );
    const test = await f.thread(w.owner);
    await f.fx.admin.query(`UPDATE threads SET is_test = true WHERE id = $1`, [test]);
    expect((await launch(w, test, appId)).status).toBe(404);
  });

  it("leaves no thread behind when a new-thread launch fails (LOW-4)", async () => {
    const w = await f.world();
    const { appId } = await app(w);
    const count = async () =>
      (
        await f.fx.admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM threads WHERE team_id = $1`,
          [w.team],
        )
      ).rows[0]?.n;
    answer = { content: [{ type: "text", text: "boom" }], isError: true };
    try {
      expect((await w.owner.browser.post(`/v1/threads/app-cards`, { app_id: appId })).status).toBe(
        502,
      );
      expect(await count()).toBe(0);
    } finally {
      answer = {
        content: [{ type: "text", text: "3 namespaces: a, b, c" }],
        structuredContent: STRUCTURED,
      };
    }
  });
});

describe("KOBE-440 re-review (LOW-R1, LOW-R2)", () => {
  it("drops a waiting card whose opening tool left the exposure or drifted (LOW-R1)", async () => {
    const w = await f.world();
    const { connector, appId } = await app(w);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = await f.thread(w.owner);
    const busy = await f.message(w.owner, threadId, "busy");
    const start = await ws.started(busy);
    expect((await launch(w, threadId, appId)).json.queued).toBe(true);
    await f.fx.admin.query(
      `UPDATE team_connectors SET exposure = 'custom', enabled_tools = '{}'
        WHERE team_id = $1 AND connector_id = $2`,
      [w.team, connector.id],
    );
    ws.reply(start, "done");
    await f.until(w.team, busy, "completed");
    await expect.poll(() => dropped(w.team)).toEqual(["no_access"]);

    // A drifted opening tool drops it too.
    await f.fx.admin.query(
      `UPDATE team_connectors SET exposure = 'all' WHERE team_id = $1 AND connector_id = $2`,
      [w.team, connector.id],
    );
    const again = await f.message(w.owner, threadId, "busy again");
    const second = await ws.started(again);
    expect((await launch(w, threadId, appId)).json.queued).toBe(true);
    await f.fx.admin.query(
      `UPDATE connectors SET tools_snapshot = jsonb_set(tools_snapshot, '{0,status}', '"drifted"')
        WHERE id = $1`,
      [connector.id],
    );
    ws.reply(second, "done");
    await f.until(w.team, again, "completed");
    await expect.poll(() => dropped(w.team)).toEqual(["no_access", "no_access"]);
    expect((await entries(w.team, threadId)).some((r) => r.type === "custom_message")).toBe(false);
  });

  it("keeps a card launched during Stop's grace waiting; the sweep then puts it on the run's branch (LOW-R2)", async () => {
    const w = await f.world();
    const { appId } = await app(w);
    const ws = await f.connect(w, 0, CAPS);
    const threadId = await answered(w, ws);
    // A stopped run whose abort Pi has not confirmed yet.
    const { rows } = await f.fx.admin.query<{ id: string }>(
      `SELECT id FROM runs WHERE thread_id = $1 LIMIT 1`,
      [threadId],
    );
    await f.fx.admin.query(
      `UPDATE runs SET stop_mode = 'abort', stop_requested_at = now() WHERE id = $1`,
      [rows[0]?.id],
    );
    const held = await launch(w, threadId, appId);
    expect([held.status, held.json.queued]).toEqual([201, true]);
    expect((await entries(w.team, threadId)).some((r) => r.type === "custom_message")).toBe(false);
    // Past the hold, the sweep finds the thread and its promotion inserts the card at the leaf.
    await new Promise((r) => setTimeout(r, 3_200));
    const sweep = await sweepRuns(
      f.fx.replica(0).deps.database.db,
      {
        startDeadlineMs: 3_600_000,
        compactionDeadlineMs: 3_600_000,
        stallMs: 0,
        stopResendMs: 3_600_000,
      },
      logger,
    );
    expect(sweep.stalledThreads.map((t) => t.threadId)).toContain(threadId);
    const leafBefore = await leaf(threadId);
    const runId = await f.message(w.owner, threadId, "and now?");
    const start = await ws.started(runId);
    expect(start.app_cards).toHaveLength(1);
    expect(start.app_cards?.[0]?.parentId).toBe(leafBefore);
  });
});
