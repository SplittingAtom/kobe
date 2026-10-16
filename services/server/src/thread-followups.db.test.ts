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
  SERVER_CALL_LIMITS,
  SERVER_CALL_PATH,
  SERVER_CALL_TOKEN_HEADER,
  serverCallRequestSchema,
  type ServerCallClaims,
} from "@kobe/protocol";
import { deriveServerCallTokenKey, verifyServerCallToken } from "@kobe/protocol/node";
import { SseReader } from "./testing/sse.js";
import { RunFixture, type FakeWorkspace, type RunWorld } from "./testing/run-fixture.js";

/**
 * KOBE-222 (CE21 follow-ups) on the KOBE-234 contract, end to end on the server, beside the
 * KOBE-219 title path: the team switch (default off, team admins only), the run-end decision (a
 * member's run, every budget line under 80 %), the call through a fake gateway that checks the
 * server-call token as the real one does and writes the `followups` usage row, and the
 * `thread.suggestions` event on the run's stream.
 */
const MASTER = "f".repeat(48);
const KEY = deriveServerCallTokenKey(new TextEncoder().encode(MASTER));
const WAIT_MS = 20_000;

type Mode = "ok" | "soft_limit" | "hold";

interface Seen {
  readonly headers: IncomingHttpHeaders;
  readonly url: string;
  readonly body: unknown;
  readonly claims: ServerCallClaims | undefined;
}

const REPLIES = {
  title: "Q3 revenue drivers",
  followups: "1. Chart it by region\n2. What about Q4?\n3. Compare with last year\n4. A fourth",
};

const gateway = {
  mode: "ok" as Mode,
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
    KEY,
    headers[SERVER_CALL_TOKEN_HEADER],
    Math.floor(Date.now() / 1000),
  );
  const claims = verified.ok ? verified.claims : undefined;
  gateway.seen.push({ headers, url, body: JSON.parse(raw) as unknown, claims });
  if (!claims) return answer(res, 401, { error: { code: "invalid_server_call_token" } });
  if (gateway.mode === "soft_limit" && claims.purpose === "followups") {
    return answer(res, 402, { error: { code: "budget_soft_limit", message: "80 %." } });
  }
  if (gateway.mode === "hold") await new Promise<void>((r) => gateway.held.push(r));
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
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usageSource: "reported",
      durationMs: 40,
      ttfbMs: 20,
      aborted: false,
    },
  ]);
  answer(res, 200, {
    choices: [
      {
        message: { role: "assistant", content: REPLIES[claims.purpose] },
        finish_reason: "stop",
      },
    ],
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

/** A world with a model, a connected sandbox and (optionally) the team switch on. */
async function setUp(on: boolean): Promise<{ w: RunWorld; ws: FakeWorkspace }> {
  const w = await f.world();
  await enableModel(w.team, w.owner.id);
  if (on) {
    const res = await f.on(0, w.owner).put("/v1/team/settings", { followups_enabled: true });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  }
  return { w, ws: await f.connect(w, 0) };
}

async function answered(
  w: RunWorld,
  ws: FakeWorkspace,
  threadId: string,
  prompt: string,
  beforeReply?: (runId: string) => Promise<void>,
): Promise<string> {
  const runId = await f.message(w.owner, threadId, prompt);
  const start = await ws.started(runId);
  await beforeReply?.(runId);
  ws.reply(start, "Mostly renewals, then new logos in EMEA.");
  await until(async () => (await f.status(w.team, runId)) === "completed", "run completed");
  return runId;
}

const types = async (team: string, runId: string) =>
  (await f.events(team, runId)).map((e) => e.type);

const epilogueOf = async (team: string, runId: string) =>
  (
    (await f.events(team, runId)).find((e) => e.type === "run.completed")?.payload as
      { epilogue?: string[] } | undefined
  )?.epilogue;

const settled = () => f.fx.replica(0).deps.background.idle();

const followupCalls = () => gateway.seen.filter((s) => s.claims?.purpose === "followups");

describe("follow-ups (KOBE-222)", () => {
  it("are off by default; only a team admin turns them on, audited (ac-3)", async () => {
    gateway.mode = "ok";
    gateway.seen.length = 0;
    const w = await f.world();
    const member = await f.member(w.team);
    expect((await f.on(0, member).get("/v1/team/settings")).json).toEqual({
      followups_enabled: false,
    });
    const refused = await f.on(0, member).put("/v1/team/settings", { followups_enabled: true });
    expect(refused.status).toBe(403);
    const bad = await f.on(0, w.owner).put("/v1/team/settings", { followups_enabled: "yes" });
    expect(bad.status).toBe(400);
    const on = await f.on(0, w.owner).put("/v1/team/settings", { followups_enabled: true });
    expect(on.json).toEqual({ followups_enabled: true });
    expect((await f.on(0, member).get("/v1/team/settings")).json).toEqual({
      followups_enabled: true,
    });
    const { rows } = await f.fx.admin.query<{ target: unknown }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'models.followups.changed'`,
      [w.team],
    );
    expect(rows.map((r) => r.target)).toEqual([{ enabled: true }]);
    // Other teams are untouched (the switch lives on this team's row).
    const other = await f.world();
    expect((await f.on(0, other.owner).get("/v1/team/settings")).json).toEqual({
      followups_enabled: false,
    });
  });

  it("with the switch off: nothing announced, nothing called (ac-1, ac-4)", async () => {
    gateway.mode = "ok";
    gateway.seen.length = 0;
    const { w, ws } = await setUp(false);
    const threadId = await f.thread(w.owner);
    const runId = await answered(w, ws, threadId, "What drives our Q3 revenue?");
    await settled();
    expect(await epilogueOf(w.team, runId)).toBeUndefined();
    expect(gateway.seen).toHaveLength(0);
  });

  it("with the switch on: announced, one followups call, three lines as thread.suggestions, a followups usage row (ac-2, ac-5, ac-6)", async () => {
    gateway.mode = "ok";
    gateway.seen.length = 0;
    const { w, ws } = await setUp(true);
    const threadId = await f.thread(w.owner);
    const runId = await answered(w, ws, threadId, "What drives our Q3 revenue?");
    expect(await epilogueOf(w.team, runId)).toEqual(["followups"]);
    await until(async () => (await types(w.team, runId)).includes("thread.suggestions"), "event");
    const events = await f.events(w.team, runId);
    expect(events.at(-2)?.type).toBe("run.completed");
    expect(events.at(-1)).toMatchObject({
      type: "thread.suggestions",
      payload: {
        thread_id: threadId,
        suggestions: ["Chart it by region", "What about Q4?", "Compare with last year"],
      },
    });
    expect(await f.status(w.team, runId)).toBe("completed");

    const calls = followupCalls();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(SERVER_CALL_PATH);
    expect(call?.claims).toMatchObject({
      purpose: "followups",
      team_id: w.team,
      user_id: w.owner.id,
      thread_id: threadId,
      run_id: runId,
      model: "openai/gpt-fake",
      max_output_tokens: SERVER_CALL_LIMITS.followups.max_output_tokens,
    });
    const body = serverCallRequestSchema.parse(call?.body);
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(SERVER_CALL_LIMITS.followups.max_output_tokens);
    expect(JSON.stringify(body.messages)).toContain("What drives our Q3 revenue?");
    expect(JSON.stringify(body.messages)).toContain("Mostly renewals");
    for (const h of ["authorization", "x-api-key", "x-kobe-run-id"]) {
      expect(call?.headers[h]).toBeUndefined();
    }

    await settled();
    const { rows } = await f.fx.admin.query<{ kind: string; sandbox_id: string | null }>(
      `SELECT kind, sandbox_id FROM run_usage WHERE team_id = $1 AND run_id = $2`,
      [w.team, runId],
    );
    expect(rows).toEqual([{ kind: "followups", sandbox_id: null }]);
  });

  it("runs beside a title on an untitled thread: both announced, both events (concurrent epilogue)", async () => {
    gateway.mode = "ok";
    gateway.seen.length = 0;
    const { w, ws } = await setUp(true);
    const created = await f.on(0, w.owner).post("/v1/threads", {});
    const threadId = created.json.thread_id as string;
    const runId = await answered(w, ws, threadId, "What drives our Q3 revenue?");
    expect(await epilogueOf(w.team, runId)).toEqual(["title", "followups"]);
    await until(async () => {
      const t = await types(w.team, runId);
      return t.includes("thread.updated") && t.includes("thread.suggestions");
    }, "both epilogue events");
    expect(gateway.seen.map((s) => s.claims?.purpose).sort()).toEqual(["followups", "title"]);
  });

  it("keeps the stream open after run.completed until thread.suggestions arrives", async () => {
    gateway.mode = "hold";
    gateway.seen.length = 0;
    const { w, ws } = await setUp(true);
    const threadId = await f.thread(w.owner);
    const runId = await answered(w, ws, threadId, "What drives our Q3 revenue?");
    await until(async () => gateway.held.length > 0, "the held call");
    const terminal = (await f.events(w.team, runId)).find((e) => e.type === "run.completed");
    const res = await f.fx.open(0, w.owner, runId, { lastEventId: String(terminal?.seq) });
    expect(res.status).toBe(200);
    const reader = new SseReader(res.body);
    for (const release of gateway.held.splice(0)) release();
    const rest = await reader.rest();
    expect(rest.map((e) => e.type)).toEqual(["thread.suggestions"]);
    gateway.mode = "ok";
  });

  it("are skipped when one of the member's budget lines is at 80 % or more (ac-2, ac-4)", async () => {
    gateway.mode = "ok";
    gateway.seen.length = 0;
    const { w, ws } = await setUp(true);
    await f.fx.admin.query(
      `INSERT INTO team_budgets (team_id, user_id, monthly_tokens, updated_by)
       VALUES ($1, $2, 1000, $2)`,
      [w.team, w.owner.id],
    );
    // Spend comes only from run_usage (each follow-up call records 120 tokens): move the limit.
    const spent = async () =>
      Number(
        (
          await f.fx.admin.query<{ t: string }>(
            `SELECT coalesce(sum(tokens), 0) AS t FROM model_spend_daily
              WHERE team_id = $1 AND user_id = $2`,
            [w.team, w.owner.id],
          )
        ).rows[0]?.t,
      );
    const limit = (tokens: number) =>
      f.fx.admin.query(`UPDATE team_budgets SET monthly_tokens = $2 WHERE team_id = $1`, [
        w.team,
        tokens,
      ]);
    const threadId = await f.thread(w.owner);
    const first = await answered(w, ws, threadId, "Far under the line");
    expect(await epilogueOf(w.team, first)).toEqual(["followups"]);
    await settled();
    expect(await spent()).toBe(120);
    await limit(151); // 79.5 %: still asked
    const under = await answered(w, ws, threadId, "Just under the line");
    expect(await epilogueOf(w.team, under)).toEqual(["followups"]);
    await settled();
    expect(await spent()).toBe(240);
    await limit(300); // exactly 80 %: skipped
    gateway.seen.length = 0;
    const at = await answered(w, ws, threadId, "At the line");
    await settled();
    expect(await epilogueOf(w.team, at)).toBeUndefined();
    expect(gateway.seen).toHaveLength(0);
  });

  it("are skipped for a scheduled run (ac-4)", async () => {
    gateway.mode = "ok";
    gateway.seen.length = 0;
    const { w, ws } = await setUp(true);
    const threadId = await f.thread(w.owner);
    const runId = await answered(w, ws, threadId, "Scheduled", async (id) => {
      await f.fx.admin.query(`UPDATE runs SET trigger = 'schedule' WHERE id = $1`, [id]);
    });
    await settled();
    expect(await epilogueOf(w.team, runId)).toBeUndefined();
    expect(gateway.seen).toHaveLength(0);
  });

  it("a gateway 402 budget_soft_limit writes nothing and never fails the run (ac-4 backstop)", async () => {
    gateway.mode = "soft_limit";
    gateway.seen.length = 0;
    const { w, ws } = await setUp(true);
    const threadId = await f.thread(w.owner);
    const runId = await answered(w, ws, threadId, "What drives our Q3 revenue?");
    await settled();
    expect(followupCalls()).toHaveLength(1);
    expect(await types(w.team, runId)).not.toContain("thread.suggestions");
    expect(await types(w.team, runId)).not.toContain("run.failed");
    expect(await f.status(w.team, runId)).toBe("completed");
    gateway.mode = "ok";
  });
});
