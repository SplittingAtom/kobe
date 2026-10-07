import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  MODELS_BUDGETS_PREFIX,
  MODELS_SPEND_PREFIX,
  SecretBox,
  VIRTUAL_KEY_PURPOSE,
  and,
  createDb,
  eq,
  isNull,
  loadGatewayPrices,
  loadGatewayPrincipal,
  loadMemberBudgetState,
  modelCatalog,
  modelGatewayKeys,
  modelProviders,
  notifyModels,
  recordModelUsage,
  sandboxes,
  teamBudgets,
  teamMembers,
  teamModels,
  teams,
  users,
  virtualKeyContext,
  withTeam,
  type KobeDatabase,
} from "@kobe/db";
import { signSessionToken, verifySessionToken } from "@kobe/session-token";
import { noRunTokens } from "./testing/run-tokens.js";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BudgetGate } from "./budget-gate.js";
import { createModelGateway } from "./gateway.js";
import { ByteBudget, CallLimiter, RequestRate } from "./limits.js";
import { ModelsListener } from "./listener.js";
import { PrincipalCache } from "./principals.js";
import { DbUsageSink } from "./usage/sink.js";

/**
 * KOBE-42 through the real shim with Postgres: a token budget on a model without prices (user
 * decision 2026-10-04). The first call's usage lands in the ledger, the sink's `spend:` hint drops
 * the gate's cached state (its TTL is far longer than the test), and the next call is refused
 * with 402 before Bifrost; a `budgets:` hint after the budget is raised lets calls through again.
 */
const KEY = "m".repeat(40);
const box = new SecretBox("v".repeat(40), VIRTUAL_KEY_PURPOSE);
const team = randomUUID();
const user = randomUUID();
const sandboxId = randomUUID();
const VK = `sk-bf-${randomUUID()}`;
const logger = pino({ level: "silent" });
let app: KobeDatabase;
let bifrost: Server;
let shim: Server;
let listener: ModelsListener;
let sink: DbUsageSink;
let base = "";
let upstreamCalls = 0;

const token = () => {
  const now = Math.floor(Date.now() / 1000);
  return signSessionToken(
    {
      iss: "kobe-server",
      aud: "kobe.model-gateway",
      sub: sandboxId,
      team_id: team,
      user_id: user,
      iat: now,
      exp: now + 900,
      jti: randomUUID().replace(/-/g, ""),
    },
    KEY,
  );
};
const chat = () =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "ollama/llama-free", max_tokens: 50, messages: [] }),
  }).then(async (r) => ({ status: r.status, body: await r.text() }));

async function until(ok: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values({ id: team, slug: `bg-${team.slice(0, 8)}`, name: "B" });
  await owner.close();
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: user, name: "B", email: `${user}@b.test` });
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
  // No prices: only a token budget can cap it.
  await app.db.insert(modelCatalog).values({
    alias: `free-${team.slice(0, 8)}`,
    providerId: "ollama",
    model: "llama-free",
    createdBy: user,
  });
  await withTeam(app.db, team, async (tx) => {
    await tx.insert(teamMembers).values({ teamId: team, userId: user, role: "member" });
    await tx.insert(sandboxes).values({ teamId: team, userId: user, sandboxId, state: "running" });
    await tx
      .insert(teamModels)
      .values({ teamId: team, alias: `free-${team.slice(0, 8)}`, enabledBy: user });
    await tx.insert(modelGatewayKeys).values({
      teamId: team,
      userId: user,
      vkId: "vk-1",
      vkValueEnc: box.seal(VK, virtualKeyContext(team, user)),
    });
    await tx.insert(teamBudgets).values({ teamId: team, dailyTokens: 1_000, updatedBy: user });
  });
  bifrost = createServer((req, res) => {
    upstreamCalls++;
    req.resume();
    req.on("end", () =>
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 600, completion_tokens: 600 },
        }),
      ),
    );
  });
  await new Promise<void>((r) => bifrost.listen(0, "127.0.0.1", r));
  const db = app.db;
  const gate = new BudgetGate(
    {
      load: (t, u) => withTeam(db, t, (tx) => loadMemberBudgetState(tx, t, u)),
      prices: () => loadGatewayPrices(db),
    },
    // Far longer than the test: only the hints can make the gate see new spend or budgets.
    { ttlMs: 600_000 },
  );
  const principals = new PrincipalCache(
    { load: (t, u, s) => loadGatewayPrincipal(db, t, u, s), requestKey: async () => undefined },
    box,
    { ttlMs: 0 },
  );
  listener = new ModelsListener({
    connectionString: inject("appUrl"),
    cache: principals,
    budgets: gate,
    logger,
  });
  listener.start();
  sink = new DbUsageSink({
    write: (records) => recordModelUsage(db, records),
    logger,
    onWritten: (teamId, callIds) => {
      gate.invalidateTeam(teamId);
      gate.settle(callIds);
      void notifyModels(db, `${MODELS_SPEND_PREFIX}${teamId}`);
    },
  });
  shim = createModelGateway({
    verify: (t) => verifySessionToken(t, "kobe.model-gateway", KEY),
    runTokens: noRunTokens(),
    principals,
    isRunLeased: async () => false,
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
  // The listener is connected before the test relies on hints.
  await new Promise((r) => setTimeout(r, 500));
});
afterAll(async () => {
  shim.closeAllConnections();
  await new Promise<void>((r) => shim.close(() => r()));
  await new Promise<void>((r) => bifrost.close(() => r()));
  await sink.close();
  await listener.close();
  await app.close();
});

const tokensToday = () =>
  withTeam(app.db, team, async (tx) => {
    const state = await loadMemberBudgetState(tx, team, user);
    return state.lines.find((l) => l.unit === "tokens")?.spent ?? 0;
  });

describe("token budget through the real shim gate (KOBE-42)", () => {
  it("refuses the next call (402, before Bifrost) once the ledger shows the budget used up", async () => {
    expect((await chat()).status).toBe(200);
    expect(upstreamCalls).toBe(1);
    await until(async () => (await tokensToday()) >= 1_200);
    // The spend hint reached the gate (its cached state is dropped): refused before Bifrost.
    await until(async () => (await chat()).status === 402);
    const refused = await chat();
    expect(refused.status).toBe(402);
    expect(JSON.parse(refused.body).error).toMatchObject({
      code: "budget_exhausted",
      message: "Your team's daily token budget is used up.",
    });
    expect(upstreamCalls).toBe(1);
  });

  it("a raised budget (budgets: hint) lets calls through again", async () => {
    await withTeam(app.db, team, (tx) =>
      tx
        .update(teamBudgets)
        .set({ dailyTokens: 1_000_000 })
        .where(and(eq(teamBudgets.teamId, team), isNull(teamBudgets.userId))),
    );
    await notifyModels(app.db, `${MODELS_BUDGETS_PREFIX}${team}`);
    await until(async () => (await chat()).status === 200);
    expect(upstreamCalls).toBe(2);
  });
});
