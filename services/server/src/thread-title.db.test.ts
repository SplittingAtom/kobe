import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordModelUsage } from "@kobe/db";
import {
  RUN_TOKEN_HEADER,
  SERVER_CALL_LIMITS,
  SERVER_CALL_PATH,
  SERVER_CALL_TOKEN_HEADER,
  serverCallRequestSchema,
  type ServerCallClaims,
} from "@kobe/protocol";
import { generateSessionKeyPair, verifyServerCallToken } from "@kobe/session-token";
import { SseReader } from "./testing/sse.js";
import { threadCardSchema } from "./threads/schemas.js";
import { withAppendTx } from "./event-stream/append.js";
import { endRunInTx } from "./sandbox-wire/run-state.js";
import { RunFixture, type FakeWorkspace, type RunWorld } from "./testing/run-fixture.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-219 (CE18 auto-titles) on the KOBE-234 contract, end to end on the server: a scripted
 * sandbox completes a message run, the run-end transaction announces `epilogue: ["title"]`, and
 * the server calls a (fake) model gateway with a server-call token alone; the gateway checks the
 * token as the real one does and writes the `title` usage row with no sandbox
 * (`recordModelUsage`, the gateway's own writer). Covers ac-1, ac-4, ac-5, ac-6, ac-8, ac-9.
 */
const PAIR = generateSessionKeyPair();
const KEY = PAIR.signing;
/** A distinctive slice of the private key: never on the wire. */
const MASTER = PAIR.privatePem.slice(30, 70);
const WAIT_MS = 20_000;

type Mode = "ok" | "budget" | "hold" | "empty" | "length";

interface Seen {
  readonly headers: IncomingHttpHeaders;
  readonly url: string;
  readonly body: unknown;
  readonly claims: ServerCallClaims | undefined;
}

const gateway = {
  mode: "ok" as Mode,
  reply: '"Q3 revenue drivers."',
  seen: [] as Seen[],
  held: [] as (() => void)[],
};

const f = new RunFixture();
let server: Server;

function answer(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handle(headers: IncomingHttpHeaders, url: string, raw: string, res: ServerResponse) {
  const verified = verifyServerCallToken(
    PAIR.verify,
    headers[SERVER_CALL_TOKEN_HEADER],
    Math.floor(Date.now() / 1000),
  );
  const claims = verified.ok ? verified.claims : undefined;
  const body = JSON.parse(raw) as unknown;
  gateway.seen.push({ headers, url, body, claims });
  if (!claims) return answer(res, 401, { error: { code: "invalid_server_call_token" } });
  if (gateway.mode === "budget") {
    return answer(res, 402, { error: { code: "budget_exhausted", message: "Budget used up." } });
  }
  if (gateway.mode === "hold") await new Promise<void>((r) => gateway.held.push(r));
  // The gateway's ledger row for a server call: kind = purpose, no sandbox, the token's run.
  await recordModelUsage(f.fx.db, [
    {
      id: randomUUID(),
      teamId: claims.team_id,
      userId: claims.user_id,
      sandboxId: undefined,
      kind: claims.purpose,
      runId: claims.run_id,
      at: new Date(),
      route: "openai",
      model: claims.model,
      status: 200,
      inputTokens: 120,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usageSource: "reported",
      durationMs: 40,
      ttfbMs: 20,
      aborted: false,
    },
  ]);
  // A reasoning model that spent its allowance thinking, or one cut off mid-title (review H1, M2).
  const content = gateway.mode === "empty" ? "" : gateway.reply;
  const finish = gateway.mode === "length" ? "length" : "stop";
  answer(res, 200, {
    choices: [{ message: { role: "assistant", content }, finish_reason: finish }],
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      handle(req.headers, req.url ?? "", raw, res).catch(() => answer(res, 500, {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await f.setup({ serverCalls: { gatewayUrl, key: KEY } });
}, 120_000);

afterAll(async () => {
  for (const release of gateway.held) release();
  await f.teardown();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

async function until<T>(
  read: () => Promise<T | null | undefined | false>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const v = await read();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The site catalog's model and the team's default, as the admin API would leave them. */
async function enableModel(team: string, ownerId: string): Promise<void> {
  const admin = f.fx.admin;
  await admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1)
     ON CONFLICT (id) DO NOTHING`,
    [ownerId],
  );
  await admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by)
     VALUES ('fast', 'openai', 'gpt-fake', $1) ON CONFLICT (alias) DO NOTHING`,
    [ownerId],
  );
  await admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'fast', true, $2)`,
    [team, ownerId],
  );
}

async function untitledThread(p: Person): Promise<string> {
  const res = await f.on(0, p).post("/v1/threads", {});
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  expect(res.json.title).toBeNull();
  return res.json.thread_id as string;
}

async function threadRow(team: string, threadId: string) {
  const { rows } = await f.fx.admin.query<{ title: string | null; title_locked: boolean }>(
    `SELECT title, title_locked FROM threads WHERE team_id = $1 AND id = $2`,
    [team, threadId],
  );
  return rows[0];
}

/** Sends a message and lets the scripted sandbox answer it; resolves once the run completed. */
async function answered(
  w: RunWorld,
  ws: FakeWorkspace,
  threadId: string,
  prompt: string,
): Promise<string> {
  const runId = await f.message(w.owner, threadId, prompt);
  const start = await ws.started(runId);
  ws.reply(start, "Mostly renewals, then new logos in EMEA.");
  await until(async () => (await f.status(w.team, runId)) === "completed", "run completed");
  return runId;
}

const types = async (team: string, runId: string) =>
  (await f.events(team, runId)).map((e) => e.type);

const completedPayload = async (team: string, runId: string) =>
  (await f.events(team, runId)).find((e) => e.type === "run.completed")?.payload;

const settled = () => f.fx.replica(0).deps.background.idle();

/**
 * Waits until the gateway has seen `n` calls, then for background work to settle: a title call
 * starts after `run.completed`, so `settled()` alone can run before it is even queued (CI load).
 */
async function gatewaySaw(n: number): Promise<void> {
  await until(async () => gateway.seen.length >= n, `gateway saw ${n} calls`);
  await settled();
}

describe("auto-titles (KOBE-219)", () => {
  it("titles a new thread once after its first completed run, through the gateway with the server-call token alone", async () => {
    gateway.mode = "ok";
    gateway.seen.length = 0;
    const w = await f.world();
    await enableModel(w.team, w.owner.id);
    const ws = await f.connect(w, 0);
    const threadId = await untitledThread(w.owner);
    const runId = await answered(w, ws, threadId, "What drives our Q3 revenue?");

    const title = await until(async () => (await threadRow(w.team, threadId))?.title, "title");
    expect(title).toBe("Q3 revenue drivers");
    expect((await threadRow(w.team, threadId))?.title_locked).toBe(false);
    expect(await completedPayload(w.team, runId)).toMatchObject({ epilogue: ["title"] });
    await until(async () => (await types(w.team, runId)).includes("thread.updated"), "event");
    const events = await f.events(w.team, runId);
    expect(events.at(-2)?.type).toBe("run.completed");
    expect(events.at(-1)).toMatchObject({
      type: "thread.updated",
      payload: { thread_id: threadId, title: "Q3 revenue drivers" },
    });
    expect(await f.status(w.team, runId)).toBe("completed");

    // ac-4 / ac-8: one non-streaming call, the token alone, bound to this run and member.
    expect(gateway.seen).toHaveLength(1);
    const [call] = gateway.seen;
    expect(call?.url).toBe(SERVER_CALL_PATH);
    expect(call?.claims).toMatchObject({
      purpose: "title",
      team_id: w.team,
      user_id: w.owner.id,
      thread_id: threadId,
      run_id: runId,
      model: "openai/gpt-fake",
      max_output_tokens: SERVER_CALL_LIMITS.title.max_output_tokens,
    });
    const body = serverCallRequestSchema.parse(call?.body);
    expect(body.stream).toBe(false);
    expect(JSON.stringify(body.messages)).toContain("What drives our Q3 revenue?");
    for (const h of ["authorization", "x-api-key", "x-goog-api-key", "api-key", "x-kobe-run-id"]) {
      expect(call?.headers[h]).toBeUndefined();
    }
    expect(call?.headers[RUN_TOKEN_HEADER]).toBeUndefined();
    expect(JSON.stringify(call)).not.toContain(MASTER);
    expect(JSON.stringify(call)).not.toContain("sealed-provider-key");

    // ac-9: the usage row of kind `title` has no sandbox; per-run usage leaves it out (ac-7).
    const { rows } = await f.fx.admin.query<{ kind: string; sandbox_id: string | null }>(
      `SELECT kind, sandbox_id FROM run_usage WHERE team_id = $1 AND run_id = $2`,
      [w.team, runId],
    );
    expect(rows).toEqual([{ kind: "title", sandbox_id: null }]);
    const usage = await f.on(0, w.owner).get(`/v1/threads/${threadId}/usage`);
    expect(usage.status, JSON.stringify(usage.json)).toBe(200);
    expect(usage.json.runs).toEqual([]);

    // Titled once: the next completed run announces nothing and calls nothing.
    const second = await answered(w, ws, threadId, "And Q4?");
    await settled();
    expect((await completedPayload(w.team, second))?.epilogue).toBeUndefined();
    expect(gateway.seen).toHaveLength(1);
    expect((await threadRow(w.team, threadId))?.title).toBe("Q3 revenue drivers");
  });

  it("never titles a renamed thread; a rename during the call wins and no event is sent", async () => {
    gateway.seen.length = 0;
    const w = await f.world();
    await enableModel(w.team, w.owner.id);
    const ws = await f.connect(w, 0);

    // Renamed before its first run: titled by hand and locked, so nothing is announced.
    const named = await untitledThread(w.owner);
    const rename = await f.on(0, w.owner).patch(`/v1/threads/${named}`, { title: "Mine" });
    expect(rename.status, JSON.stringify(rename.json)).toBe(200);
    gateway.mode = "ok";
    const run = await answered(w, ws, named, "Hello there");
    await settled();
    expect((await completedPayload(w.team, run))?.epilogue).toBeUndefined();
    expect(gateway.seen).toHaveLength(0);
    expect(await threadRow(w.team, named)).toEqual({ title: "Mine", title_locked: true });

    // Renamed while the title call is in flight: the rename wins, no thread.updated.
    gateway.mode = "hold";
    const racing = await untitledThread(w.owner);
    const runId = await answered(w, ws, racing, "What drives our Q3 revenue?");
    await until(async () => gateway.held.length > 0, "the held title call");
    const renamed = await f.on(0, w.owner).patch(`/v1/threads/${racing}`, { title: "By hand" });
    expect(renamed.status, JSON.stringify(renamed.json)).toBe(200);
    for (const release of gateway.held.splice(0)) release();
    await settled();
    expect(await threadRow(w.team, racing)).toEqual({ title: "By hand", title_locked: true });
    expect(await types(w.team, runId)).not.toContain("thread.updated");
    expect(await f.status(w.team, runId)).toBe("completed");
  });

  it("at 100 % budget (gateway 402) leaves no generated title and no failed run; three attempts, then the first line (review M3)", async () => {
    gateway.mode = "budget";
    gateway.seen.length = 0;
    const w = await f.world();
    await enableModel(w.team, w.owner.id);
    const ws = await f.connect(w, 0);
    const threadId = await untitledThread(w.owner);
    const runs: string[] = [];
    for (const prompt of ["One", "Two", "Three", "Four"]) {
      runs.push(await answered(w, ws, threadId, prompt));
      // Three attempts, one per run; the fourth run makes no call.
      await gatewaySaw(Math.min(runs.length, 3));
    }
    // After the third failed attempt the first prompt's first line, unlocked, with its event.
    expect(await threadRow(w.team, threadId)).toEqual({ title: "One", title_locked: false });
    for (const runId of runs) {
      expect(await f.status(w.team, runId)).toBe("completed");
      expect(await types(w.team, runId)).not.toContain("run.failed");
    }
    const updated: boolean[] = [];
    for (const r of runs) updated.push((await types(w.team, r)).includes("thread.updated"));
    expect(updated).toEqual([false, false, true, false]);
    // The first three completed runs announce a title and try once each; the fourth does not.
    const announced: unknown[] = [];
    for (const r of runs) announced.push((await completedPayload(w.team, r))?.epilogue);
    expect(announced).toEqual([["title"], ["title"], ["title"], undefined]);
    expect(gateway.seen).toHaveLength(3);
    const { rows } = await f.fx.admin.query(
      `SELECT 1 FROM run_usage WHERE team_id = $1 AND kind = 'title'`,
      [w.team],
    );
    expect(rows).toHaveLength(0);
  });

  it("keeps the event stream open after run.completed until thread.updated (ac-6)", async () => {
    gateway.mode = "hold";
    const w = await f.world();
    await enableModel(w.team, w.owner.id);
    const ws = await f.connect(w, 0);
    const threadId = await untitledThread(w.owner);
    const runId = await answered(w, ws, threadId, "What drives our Q3 revenue?");
    await until(async () => gateway.held.length > 0, "the held title call");
    const terminal = (await f.events(w.team, runId)).find((e) => e.type === "run.completed");
    // A reconnect right after run.completed: the epilogue is open, so the server streams.
    const res = await f.fx.open(0, w.owner, runId, { lastEventId: String(terminal?.seq) });
    expect(res.status).toBe(200);
    const reader = new SseReader(res.body);
    for (const release of gateway.held.splice(0)) release();
    const rest = await reader.rest();
    expect(rest.map((e) => e.type)).toEqual(["thread.updated"]);
    // Everything delivered and nothing more announced: the next reconnect is a 204.
    const last = rest.at(-1)?.seq;
    const again = await f.fx.open(0, w.owner, runId, { lastEventId: String(last) });
    expect(again.status).toBe(204);
  });

  it("answers the rail's hover card: first message, agent, last activity, message count (ac-3)", async () => {
    gateway.mode = "ok";
    const w = await f.world(1);
    await enableModel(w.team, w.owner.id);
    const ws = await f.connect(w, 0);
    const threadId = await untitledThread(w.owner);
    const long = `What drives our Q3 revenue? ${"Tell me more. ".repeat(40)}`;
    await answered(w, ws, threadId, long);
    await answered(w, ws, threadId, "And Q4?");
    const res = await f.on(0, w.owner).get(`/v1/threads/${threadId}/card`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const card = threadCardSchema.parse(res.json);
    expect(card.first_message?.startsWith("What drives our Q3 revenue? Tell me more.")).toBe(true);
    expect(card.first_message?.length).toBe(280);
    expect(card.first_message_truncated).toBe(true);
    expect(card).toMatchObject({ thread_id: threadId, agent_id: null, agent_name: null });
    expect(card.message_count).toBe(4);
    expect(Date.parse(card.last_activity_at)).toBeGreaterThan(Date.now() - 60_000);
    // A teammate the thread is not shared with sees nothing (same 404 as an unknown thread).
    const other = w.others[0];
    if (!other) throw new Error("no teammate");
    expect((await f.on(0, other).get(`/v1/threads/${threadId}/card`)).status).toBe(404);
    expect((await f.on(0, w.owner).get(`/v1/threads/${randomUUID()}/card`)).status).toBe(404);
    expect((await f.on(0, w.owner).get(`/v1/threads/nope/card`)).status).toBe(400);
  });

  it("asks a catalog reasoning model for a low effort within the reasoning headroom (review H1)", async () => {
    gateway.mode = "ok";
    gateway.seen.length = 0;
    const w = await f.world();
    await enableModel(w.team, w.owner.id);
    await f.fx.admin.query(`UPDATE model_catalog SET reasoning = true WHERE alias = 'fast'`);
    try {
      const ws = await f.connect(w, 0);
      const threadId = await untitledThread(w.owner);
      await answered(w, ws, threadId, "What drives our Q3 revenue?");
      await until(async () => (await threadRow(w.team, threadId))?.title, "title");
      const body = serverCallRequestSchema.parse(gateway.seen[0]?.body);
      expect(body.reasoning_effort).toBe("low");
      expect(body.max_tokens).toBe(SERVER_CALL_LIMITS.title.reasoning_max_output_tokens);
      expect(gateway.seen[0]?.claims?.max_output_tokens).toBe(
        SERVER_CALL_LIMITS.title.reasoning_max_output_tokens,
      );
    } finally {
      await f.fx.admin.query(`UPDATE model_catalog SET reasoning = false WHERE alias = 'fast'`);
    }
  });

  it.each(["empty", "length"] as const)(
    "never saves a %s reply; after the last attempt the first line instead (review M1, M2)",
    async (mode) => {
      gateway.mode = mode;
      gateway.reply = "Analyse des ventes trimest";
      gateway.seen.length = 0;
      try {
        const w = await f.world();
        await enableModel(w.team, w.owner.id);
        const ws = await f.connect(w, 0);
        const threadId = await untitledThread(w.owner);
        await answered(w, ws, threadId, "Ventes trimestrielles par région ?");
        await gatewaySaw(1);
        expect(gateway.seen).toHaveLength(1);
        expect((await threadRow(w.team, threadId))?.title).toBeNull();
        await answered(w, ws, threadId, "Et en Europe ?");
        await gatewaySaw(2);
        await answered(w, ws, threadId, "Merci");
        await gatewaySaw(3);
        expect(gateway.seen).toHaveLength(3);
        expect((await threadRow(w.team, threadId))?.title).toBe(
          "Ventes trimestrielles par région ?",
        );
      } finally {
        gateway.reply = '"Q3 revenue drivers."';
      }
    },
  );

  it("a team with no model to title with gets the first line after its first run (review M3)", async () => {
    gateway.mode = "ok";
    gateway.seen.length = 0;
    const w = await f.world(); // no team model enabled
    const ws = await f.connect(w, 0);
    const threadId = await untitledThread(w.owner);
    await answered(w, ws, threadId, "Plot revenue\nby month");
    await until(async () => (await threadRow(w.team, threadId))?.title, "fallback title");
    expect(await threadRow(w.team, threadId)).toEqual({
      title: "Plot revenue",
      title_locked: false,
    });
    expect(gateway.seen).toHaveLength(0);
  });

  it("a server without titles configured gives the first line at the run's end (review M3)", async () => {
    const w = await f.world();
    const runId = await f.fx.run(w.team, w.owner);
    const { thread_id: threadId } = await f.run(w.team, runId);
    await f.fx.admin.query(`UPDATE runs SET input = $2 WHERE id = $1`, [
      runId,
      "Summarise the report\nplease",
    ]);
    // No server calls on this server: nothing is announced, the fallback is written in the end.
    const ended = await withAppendTx(f.fx.db, w.team, (tx) =>
      endRunInTx(tx, w.team, runId, { status: "completed" }),
    );
    expect(ended.ended).toBe(true);
    expect((await completedPayload(w.team, runId))?.epilogue).toBeUndefined();
    expect(await threadRow(w.team, threadId)).toEqual({
      title: "Summarise the report",
      title_locked: false,
    });
  });
});
