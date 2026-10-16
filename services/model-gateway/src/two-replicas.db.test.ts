import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  MODELS_SPEND_PREFIX,
  SecretBox,
  VIRTUAL_KEY_PURPOSE,
  createDb,
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
import pino from "pino";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BudgetGate } from "./budget-gate.js";
import { createModelGateway } from "./gateway.js";
import { ByteBudget, CallLimiter, RequestRate } from "./limits.js";
import { ModelsListener } from "./listener.js";
import { PrincipalCache } from "./principals.js";
import { DbReservations } from "./reservations-db.js";
import { noRunTokens } from "./testing/run-tokens.js";
import { DbUsageSink } from "./usage/sink.js";

/**
 * KOBE-121 (ac-1): two independent gateway replicas (own pool, gate, sink and listener) share one
 * Postgres. Concurrent calls from several members against a small hard team token budget must not
 * overshoot it by more than one call, whichever replica serves them, including calls fired right
 * after the first wave ended (their ledger rows may not be visible yet: until a row lands its call
 * keeps its hold, and the reservation reads the spend itself, KOBE-286).
 */
const KEY = "m".repeat(40);
const box = new SecretBox("v".repeat(40), VIRTUAL_KEY_PURPOSE);
const logger = pino({ level: "silent" });
const team = randomUUID();
const MEMBERS = 8;
const members = Array.from({ length: MEMBERS }, () => ({
  user: randomUUID(),
  sandboxId: randomUUID(),
}));
const BODY = JSON.stringify({ model: "ollama/llama-free", max_tokens: 50, messages: [] });
/** What one call reserves (input estimate + output allowance) and the fake upstream reports. */
const CALL_TOKENS = Math.ceil(BODY.length / 4) + 50;
const ALLOWED_CALLS = 10;
/** 10.5 calls: the 11th is admitted (spend + holds are still below the limit) and may overshoot. */
const LIMIT = Math.round(ALLOWED_CALLS * CALL_TOKENS + CALL_TOKENS / 2);

let owner: KobeDatabase;
let bifrost: Server;
let upstreamCalls = 0;

interface Replica {
  readonly base: string;
  readonly close: () => Promise<void>;
}

async function startReplica(): Promise<Replica> {
  const app = createDb(inject("appUrl"), { max: 6 });
  const db = app.db;
  const gate = new BudgetGate(
    {
      load: (t, u) => withTeam(db, t, (tx) => loadMemberBudgetState(tx, t, u)),
      prices: () => loadGatewayPrices(db),
    },
    {
      ttlMs: 600_000,
      reservations: new DbReservations(db, {
        ttlMs: 60_000,
        salt: createHash("sha256").update("two-replicas").digest("hex"),
      }),
    },
  );
  const principals = new PrincipalCache(
    { load: (t, u, s) => loadGatewayPrincipal(db, t, u, s), requestKey: async () => undefined },
    box,
    { ttlMs: 0 },
  );
  const listener = new ModelsListener({
    connectionString: inject("appUrl"),
    cache: principals,
    budgets: gate,
    logger,
  });
  listener.start();
  const sink = new DbUsageSink({
    write: (records) => recordModelUsage(db, records),
    logger,
    onWritten: (teamId, callIds) => {
      gate.invalidateTeam(teamId);
      gate.settle(teamId, callIds);
      void notifyModels(db, `${MODELS_SPEND_PREFIX}${teamId}`);
    },
  });
  const shim = createModelGateway({
    verify: (t) => verifySessionToken(t, "kobe.model-gateway", KEY),
    runTokens: noRunTokens(),
    principals,
    isRunLeased: async () => false,
    bifrostUrl: `http://127.0.0.1:${(bifrost.address() as AddressInfo).port}`,
    limiter: new CallLimiter({ perSandbox: 8, total: 64 }),
    bytes: new ByteBudget({ perSandbox: 65_536, total: 1_048_576 }),
    rate: new RequestRate({ burst: 1_000, perSecond: 1_000 }),
    gate,
    sink,
    onBifrostForgotKey: () => undefined,
    logger,
    settings: { maxBodyBytes: 65_536, idleTimeoutMs: 5_000 },
    ready: () => true,
  });
  await new Promise<void>((r) => shim.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(shim.address() as AddressInfo).port}`,
    close: async () => {
      shim.closeAllConnections();
      await new Promise<void>((r) => shim.close(() => r()));
      await sink.close();
      await listener.close();
      await app.close();
    },
  };
}

const token = (m: { user: string; sandboxId: string }) => {
  const now = Math.floor(Date.now() / 1000);
  return signSessionToken(
    {
      iss: "kobe-server",
      aud: "kobe.model-gateway",
      sub: m.sandboxId,
      team_id: team,
      user_id: m.user,
      iat: now,
      exp: now + 900,
      jti: randomUUID().replace(/-/g, ""),
    },
    KEY,
  );
};
const chat = (base: string, m: (typeof members)[number]) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token(m)}`, "content-type": "application/json" },
    body: BODY,
  }).then((r) => r.status);

const teamTokensSpent = () =>
  withTeam(owner.db, team, async (tx) => {
    const state = await loadMemberBudgetState(tx, team, members[0]?.user ?? "");
    return state.lines.find((l) => l.scope === "team" && l.unit === "tokens")?.spent ?? 0;
  });

async function until(ok: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

let replicas: Replica[] = [];

beforeAll(async () => {
  const su = createDb(inject("ownerUrl"));
  await su.db.insert(teams).values({ id: team, slug: `tr-${team.slice(0, 8)}`, name: "T" });
  await su.close();
  owner = createDb(inject("appUrl"));
  const creator = members[0]?.user ?? "";
  await owner.db
    .insert(users)
    .values(members.map((m) => ({ id: m.user, name: "M", email: `${m.user}@tr.test` })));
  await owner.db
    .insert(modelProviders)
    .values({
      id: "ollama",
      kind: "ollama",
      name: "Ollama",
      baseUrl: "http://ollama.invalid",
      createdBy: creator,
    })
    .onConflictDoNothing();
  const alias = `tr-${team.slice(0, 8)}`;
  await owner.db
    .insert(modelCatalog)
    .values({ alias, providerId: "ollama", model: "llama-free", createdBy: creator });
  await withTeam(owner.db, team, async (tx) => {
    await tx.insert(teamModels).values({ teamId: team, alias, enabledBy: creator });
    await tx.insert(teamBudgets).values({ teamId: team, dailyTokens: LIMIT, updatedBy: creator });
    for (const m of members) {
      await tx.insert(teamMembers).values({ teamId: team, userId: m.user, role: "member" });
      await tx
        .insert(sandboxes)
        .values({ teamId: team, userId: m.user, sandboxId: m.sandboxId, state: "running" });
      await tx.insert(modelGatewayKeys).values({
        teamId: team,
        userId: m.user,
        vkId: `vk-${m.user}`,
        vkValueEnc: box.seal(`sk-bf-${randomUUID()}`, virtualKeyContext(team, m.user)),
      });
    }
  });
  bifrost = createServer((req, res) => {
    upstreamCalls++;
    req.resume();
    // A slow answer keeps many calls in flight at once.
    req.on("end", () =>
      setTimeout(
        () =>
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: "ok" } }],
              usage: {
                prompt_tokens: CALL_TOKENS - 50,
                completion_tokens: 50,
              },
            }),
          ),
        150,
      ),
    );
  });
  await new Promise<void>((r) => bifrost.listen(0, "127.0.0.1", r));
  replicas = [await startReplica(), await startReplica()];
  // Both listeners are connected before the test relies on hints.
  await new Promise((r) => setTimeout(r, 500));
});
afterAll(async () => {
  await Promise.all(replicas.map((r) => r.close()));
  await new Promise<void>((r) => bifrost.close(() => r()));
  await owner.close();
});

describe("two gateway replicas, one hard team budget (KOBE-121 ac-1)", () => {
  it("never overshoots by more than one call, also for calls right after the first wave", async () => {
    const fire = () =>
      Promise.all(
        Array.from({ length: 40 }, (_, i) => {
          const replica = replicas[i % 2];
          const member = members[i % MEMBERS];
          if (!replica || !member) throw new Error("fixture");
          return chat(replica.base, member);
        }),
      );
    const first = await fire();
    // Straight away, before the ledger rows are visible everywhere: the holds still count.
    const second = await fire();
    const admitted = [...first, ...second].filter((s) => s === 200).length;
    expect([...first, ...second].every((s) => s === 200 || s === 402 || s === 429)).toBe(true);
    await until(async () => (await teamTokensSpent()) >= admitted * CALL_TOKENS);
    const spent = await teamTokensSpent();
    const overshoot = Math.max(0, spent - LIMIT);
    console.info(
      `KOBE-121: limit ${LIMIT} tokens, one call ${CALL_TOKENS}, admitted ${admitted}/80 over 2 replicas, spent ${spent}, overshoot ${overshoot}`,
    );
    expect(upstreamCalls).toBe(admitted);
    expect(spent).toBe(admitted * CALL_TOKENS);
    expect(overshoot).toBeLessThanOrEqual(CALL_TOKENS);
    // The budget really was the limit: nearly all of it was used, not refused early.
    expect(admitted).toBeGreaterThanOrEqual(ALLOWED_CALLS - 2);
  });
});
