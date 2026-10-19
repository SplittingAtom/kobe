import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SecretBox,
  VIRTUAL_KEY_PURPOSE,
  createDb,
  loadGatewayPrices,
  loadGatewayPrincipal,
  loadMemberBudgetState,
  modelCatalog,
  modelGatewayKeys,
  modelProviders,
  recordModelUsage,
  runs,
  sandboxRunLeases,
  serverCallRunMatches,
  sql,
  teamBudgets,
  teamMembers,
  teamModels,
  teams,
  threads,
  users,
  virtualKeyContext,
  withTeam,
  type KobeDatabase,
} from "@kobe/db";
import {
  SERVER_CALL_AUDIENCE,
  SERVER_CALL_TOKEN_HEADER,
  type ServerCallTokenPurpose,
} from "@kobe/protocol";
import { deriveServerCallTokenKey, signServerCallToken } from "@kobe/protocol/node";
import { verifySessionToken } from "@kobe/session-token";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BudgetGate } from "./budget-gate.js";
import { createModelGateway } from "./gateway.js";
import { ByteBudget, CallLimiter, RequestRate } from "./limits.js";
import { PrincipalCache } from "./principals.js";
import { DbReservations } from "./reservations-db.js";
import { ServerCallReplay } from "./server-call.js";
import { noRunTokens } from "./testing/run-tokens.js";
import { DbUsageSink } from "./usage/sink.js";

/**
 * KOBE-234 review L2/L3: server calls through the real `kobe_reserve_budget` (KOBE-120/286). The
 * gate's cached budget state is never refreshed here (long TTL, no invalidation), so what refuses
 * the second follow-up is the reservation's own spend read at 80 % of the line; a title is judged
 * on the full line and still passes. The ledger rows carry their kind.
 */
const KEY = "m".repeat(40);
const SC_KEY = deriveServerCallTokenKey(new TextEncoder().encode(KEY));
const box = new SecretBox("v".repeat(40), VIRTUAL_KEY_PURPOSE);
const team = randomUUID();
const user = randomUUID();
const VK = `sk-bf-${randomUUID()}`;
const MODEL = "ollama/llama-sc";
const logger = pino({ level: "silent" });
let app: KobeDatabase;
let bifrost: Server;
let shim: Server;
let sink: DbUsageSink;
let base = "";
let upstreamCalls = 0;
let threadId = "";
let runId = "";

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values({ id: team, slug: `sc-${team.slice(0, 8)}`, name: "SC" });
  await owner.close();
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: user, name: "S", email: `${user}@s.test` });
  await app.db
    .insert(modelProviders)
    .values({
      id: "ollama",
      kind: "ollama",
      name: "Ollama",
      baseUrl: "http://ollama.invalid",
      createdBy: user,
    })
    .onConflictDoNothing();
  await app.db.insert(modelCatalog).values({
    alias: `sc-${team.slice(0, 8)}`,
    providerId: "ollama",
    model: "llama-sc",
    createdBy: user,
  });
  ({ threadId, runId } = await withTeam(app.db, team, async (tx) => {
    await tx.insert(teamMembers).values({ teamId: team, userId: user, role: "member" });
    await tx
      .insert(teamModels)
      .values({ teamId: team, alias: `sc-${team.slice(0, 8)}`, enabledBy: user });
    await tx.insert(modelGatewayKeys).values({
      teamId: team,
      userId: user,
      vkId: "vk-1",
      vkValueEnc: box.seal(VK, virtualKeyContext(team, user)),
    });
    await tx.insert(teamBudgets).values({ teamId: team, dailyTokens: 10_000, updatedBy: user });
    const [thread] = await tx
      .insert(threads)
      .values({ teamId: team, ownerUserId: user })
      .returning({ id: threads.id });
    const [run] = await tx
      .insert(runs)
      .values({
        teamId: team,
        threadId: thread?.id ?? "",
        trigger: "user",
        status: "completed",
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .returning({ id: runs.id });
    await tx.insert(sandboxRunLeases).values({
      teamId: team,
      runId: run?.id ?? "",
      userId: user,
      threadId: thread?.id ?? "",
      sandboxId: randomUUID(),
    });
    return { threadId: thread?.id ?? "", runId: run?.id ?? "" };
  }));
  bifrost = createServer((req, res) => {
    upstreamCalls++;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const judge = Buffer.concat(chunks).toString().includes("Grade.");
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          // 8 000 of the 10 000-token daily budget: 80 % (the eval judge's call: 1 %).
          usage: judge
            ? { prompt_tokens: 50, completion_tokens: 50 }
            : { prompt_tokens: 4_000, completion_tokens: 4_000 },
        }),
      );
    });
  });
  await new Promise<void>((r) => bifrost.listen(0, "127.0.0.1", r));
  const db = app.db;
  const gate = new BudgetGate(
    {
      load: (t, u) => withTeam(db, t, (tx) => loadMemberBudgetState(tx, t, u)),
      prices: () => loadGatewayPrices(db),
    },
    {
      // Never refreshed during the test: only the database can see the new spend.
      ttlMs: 600_000,
      reservations: new DbReservations(db, {
        ttlMs: 30_000,
        salt: createHash("sha256").update(`kobe.budget-reservations:${KEY}`).digest("hex"),
      }),
    },
  );
  sink = new DbUsageSink({
    write: (records) => recordModelUsage(db, records),
    logger,
    onWritten: (teamId, callIds) => gate.settle(teamId, callIds),
  });
  shim = createModelGateway({
    verify: (t) => verifySessionToken(t, "kobe.model-gateway", KEY),
    runTokens: noRunTokens(),
    principals: new PrincipalCache(
      { load: (t, u, s) => loadGatewayPrincipal(db, t, u, s), requestKey: async () => undefined },
      box,
      { ttlMs: 0 },
    ),
    isRunLeased: async () => false,
    serverCalls: {
      key: SC_KEY,
      replay: new ServerCallReplay(),
      runMatches: (c) => serverCallRunMatches(db, c),
      limiter: new CallLimiter({ perSandbox: 4, total: 8 }),
      rate: new RequestRate({ burst: 100, perSecond: 100 }),
    },
    bifrostUrl: `http://127.0.0.1:${(bifrost.address() as AddressInfo).port}`,
    limiter: new CallLimiter({ perSandbox: 4, total: 16 }),
    bytes: new ByteBudget({ perSandbox: 65_536, total: 65_536 }),
    rate: new RequestRate({ burst: 100, perSecond: 100 }),
    gate,
    sink,
    onBifrostForgotKey: () => undefined,
    logger,
    settings: { maxBodyBytes: 65_536, idleTimeoutMs: 5_000 },
    ready: () => true,
  });
  await new Promise<void>((r) => shim.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(shim.address() as AddressInfo).port}`;
});
afterAll(async () => {
  shim.closeAllConnections();
  await new Promise<void>((r) => shim.close(() => r()));
  await new Promise<void>((r) => bifrost.close(() => r()));
  await sink.close();
  await app.close();
});

async function serverCall(purpose: ServerCallTokenPurpose) {
  const cap = purpose === "title" ? 48 : 200;
  const iat = Math.floor(Date.now() / 1000);
  const token = signServerCallToken(SC_KEY, {
    iss: "kobe-server",
    aud: SERVER_CALL_AUDIENCE,
    purpose,
    team_id: team,
    user_id: user,
    thread_id: threadId,
    run_id: runId,
    model: MODEL,
    max_output_tokens: cap,
    iat,
    exp: iat + 30,
    jti: randomUUID(),
  });
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { [SERVER_CALL_TOKEN_HEADER]: token, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "user", content: purpose === "eval_judge" ? "Grade." : "Suggest follow-ups." },
      ],
      max_tokens: cap,
      ...(purpose === "eval_judge" ? { temperature: 0 } : {}),
    }),
  });
  const body = (await res.json()) as { error?: { code?: string } };
  return { status: res.status, code: body.error?.code };
}

async function spentToday(): Promise<number> {
  return withTeam(app.db, team, async (tx) => {
    const state = await loadMemberBudgetState(tx, team, user);
    return state.lines.find((l) => l.unit === "tokens")?.spent ?? 0;
  });
}

describe("server calls through kobe_reserve_budget (KOBE-234)", () => {
  it("skips follow-ups at 80 % from the database's own spend read; titles still pass", async () => {
    // The eval judge (KOBE-326 ac-2) goes the same way and lands as its own kind.
    expect(await serverCall("eval_judge")).toEqual({ status: 200, code: undefined });
    expect(await serverCall("followups")).toEqual({ status: 200, code: undefined });
    const end = Date.now() + 10_000;
    while ((await spentToday()) < 8_000) {
      if (Date.now() > end) throw new Error("usage never landed");
      await new Promise((r) => setTimeout(r, 50));
    }
    // The gate's cache still says 0 % spent: the reservation refuses.
    expect(await serverCall("followups")).toEqual({ status: 402, code: "budget_soft_limit" });
    expect(await serverCall("title")).toEqual({ status: 200, code: undefined });
    expect(upstreamCalls).toBe(3);
    await sink.flush();
    const kinds = await withTeam(app.db, team, (tx) =>
      tx.execute<{ kind: string; sandbox_id: string | null; run_id: string; user_id: string }>(
        sql`SELECT kind, sandbox_id, run_id, user_id FROM run_usage WHERE team_id = ${team}::uuid ORDER BY at`,
      ),
    );
    expect(kinds.rows.map(({ user_id, ...r }) => (user_id === user ? r : { user_id }))).toEqual([
      { kind: "eval_judge", sandbox_id: null, run_id: runId },
      { kind: "followups", sandbox_id: null, run_id: runId },
      { kind: "title", sandbox_id: null, run_id: runId },
    ]);
  });
});
