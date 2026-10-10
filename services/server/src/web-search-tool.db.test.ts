import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITY_WEB_SEARCH, WEB_SEARCH_UNAVAILABLE_MESSAGES } from "@kobe/protocol";
import { Envelope, loadEnvelope } from "@kobe/db";
import type { PolicyEngine } from "@kobe/protocol";
import { EventStreamFixture, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { createWebSearchService, type WebSearchService } from "./web-search/service.js";
import { webSearchContext } from "./web-search/store.js";

/**
 * KOBE-114 end to end through the sandbox wire: `web_search.query` is accepted only for a connection
 * that announced `web_search`, an active leased run and an allowed `web_search` call with the same
 * input hash; the server (not the sandbox) searches with the install's sealed key. An install with
 * no provider, or a team that has not opted in, gets an "unavailable" answer. The key never appears
 * in a frame to the sandbox.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const loaded = loadEnvelope({ KOBE_ENVELOPE_KEY: "e".repeat(48) });
if (!loaded) throw new Error("test envelope");
const envelope: Envelope = loaded;
const KEY = "BSA-live-AbCdEf0123456789XyZ";
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;
let service: WebSearchService;
const providerCalls: { url: string; headers: Record<string, string> }[] = [];
let providerStatus = 200;

const fakeFetch = ((url: string, init: RequestInit) => {
  providerCalls.push({ url, headers: init.headers as Record<string, string> });
  return Promise.resolve(
    new Response(
      JSON.stringify({
        web: {
          results: [
            { title: "Kobe", url: "https://example.com/kobe", description: "About <b>Kobe</b>" },
          ],
        },
      }),
      { status: providerStatus },
    ),
  );
}) as unknown as typeof fetch;

const allowAll: PolicyEngine = {
  decide: () =>
    Promise.resolve({
      effect: "allow" as const,
      risk: "read" as const,
      reasons: [{ code: "team_allow_rule" as const, stage: "user_allow" as const, message: "ok" }],
    }),
};

beforeAll(async () => {
  await fx.setup([{}], () => ({
    sandboxWire: {
      engine: allowAll,
      sweep: false,
      webSearch: { search: (t, i) => service.search(t, i) },
      tuning: { batchWindowMs: 20, resultPollMs: 200, lostGraceMs: 0, helloTimeoutMs: 1_000 },
    },
  }));
  service = createWebSearchService({ db: fx.db, envelope, fetch: fakeFetch });
  listener = await sandboxListener(fx.replica(0).deps, auth);
});
afterAll(async () => {
  for (const s of sandboxes) s.close();
  await listener.close();
  await fx.teardown();
});

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly runId: string;
  readonly threadId: string;
  readonly sandboxId: string;
  readonly token: string;
}
async function world(): Promise<World> {
  const owner = await fx.person(`u${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`w-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  const sandboxId = randomUUID();
  return {
    team,
    owner,
    runId,
    threadId: rows[0]?.thread_id ?? "",
    sandboxId,
    token: auth.issue({ sandboxId, teamId: team, userId: owner.id }),
  };
}
async function started(w: World, capabilities: readonly string[] = [CAPABILITY_WEB_SEARCH]) {
  const sb = await FakeSandbox.connect(listener.url, w.token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(w.sandboxId, [], "1.0.0", capabilities);
  await sb.ready();
  const res = await fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: w.team, userId: w.owner.id },
      { runId: w.runId, threadId: w.threadId, message: "hi" },
    );
  expect(res).toEqual({ ok: true });
  return sb;
}

type Input = Record<string, unknown>;
let seq = 0;
async function check(sb: FakeSandbox, w: World, callId: string, input: Input) {
  const request_id = `c${seq++}`;
  sb.send({
    v: 1,
    type: "policy.check",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool: "web_search",
    input,
  });
  return sb.until(() => sb.frames("policy.result").find((r) => r.request_id === request_id), 3000);
}
async function search(sb: FakeSandbox, w: World, callId: string, input: Input) {
  const request_id = `s${seq++}`;
  sb.send({
    v: 1,
    type: "web_search.query",
    request_id,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool: "web_search",
    input,
  });
  return sb.until(
    () => sb.frames("web_search.result").find((r) => r.request_id === request_id),
    3000,
  );
}
async function allowedSearch(sb: FakeSandbox, w: World, callId: string, input: Input) {
  expect((await check(sb, w, callId, input)).decision).toBe("allow");
  return search(sb, w, callId, input);
}
/** Rows as the KOBE-113 API leaves them (the API itself is covered by web-search.db.test.ts). */
async function configure(w: World, optIn: boolean) {
  const sealed = envelope.seal(KEY, webSearchContext);
  await fx.admin.query(
    `INSERT INTO web_search_settings (id, provider, enabled, sealed, key_id, hint, updated_by)
     VALUES (1, 'brave', true, $1, $2, '••••XyZ', $3)`,
    [sealed, Envelope.keyIdOf(sealed), w.owner.id],
  );
  if (optIn) {
    await fx.admin.query(`INSERT INTO team_web_search (team_id, enabled_by) VALUES ($1, $2)`, [
      w.team,
      w.owner.id,
    ]);
  }
}
async function clearInstall() {
  await fx.admin.query(`DELETE FROM team_web_search`);
  await fx.admin.query(`DELETE FROM web_search_settings`);
}

describe("web_search.query", () => {
  it("unconfigured install: unavailable, nothing is called", async () => {
    await clearInstall();
    const w = await world();
    const sb = await started(w);
    const before = providerCalls.length;
    const res = await allowedSearch(sb, w, "c1", { query: "kobe" });
    expect(res).toMatchObject({
      ok: true,
      available: false,
      reason: "not_configured",
      message: WEB_SEARCH_UNAVAILABLE_MESSAGES.not_configured,
    });
    expect(providerCalls.length).toBe(before);
  });

  it("configured install, team not opted in: unavailable", async () => {
    await clearInstall();
    const w = await world();
    await configure(w, false);
    const sb = await started(w);
    const res = await allowedSearch(sb, w, "c1", { query: "kobe" });
    expect(res).toMatchObject({ ok: true, available: false, reason: "team_not_enabled" });
  });

  it("configured and opted in: citations come back, the key goes only to the provider", async () => {
    await clearInstall();
    const w = await world();
    await configure(w, true);
    const sb = await started(w);
    const res = await allowedSearch(sb, w, "c1", { query: "kobe", count: 3 });
    expect(res).toMatchObject({
      ok: true,
      available: true,
      provider: "brave",
      query: "kobe",
      results: [{ title: "Kobe", url: "https://example.com/kobe", snippet: "About Kobe" }],
    });
    const call = providerCalls.at(-1);
    expect(call?.url).toContain("https://api.search.brave.com/res/v1/web/search?q=kobe&count=3");
    expect(call?.headers["X-Subscription-Token"]).toBe(KEY);
    expect(JSON.stringify(sb.received)).not.toContain(KEY);
  });

  it("a provider failure is an error result without the key", async () => {
    await clearInstall();
    const w = await world();
    await configure(w, true);
    const sb = await started(w);
    providerStatus = 500;
    try {
      const res = await allowedSearch(sb, w, "c1", { query: "kobe" });
      expect(res).toMatchObject({ ok: false, error: { code: "search_failed" } });
      expect(JSON.stringify(res)).not.toContain(KEY);
    } finally {
      providerStatus = 200;
    }
  });

  it("refuses a search the policy check did not allow, with other input, or without the capability", async () => {
    await clearInstall();
    const w = await world();
    await configure(w, true);
    const sb = await started(w);
    const before = providerCalls.length;
    expect(await search(sb, w, "never-checked", { query: "kobe" })).toMatchObject({
      ok: false,
      error: { code: "not_allowed" },
    });
    expect((await check(sb, w, "c2", { query: "kobe" })).decision).toBe("allow");
    expect(await search(sb, w, "c2", { query: "something else" })).toMatchObject({
      ok: false,
      error: { code: "not_allowed" },
    });
    expect(providerCalls.length).toBe(before);

    const w2 = await world();
    const bare = await started(w2, []);
    expect(await allowedSearch(bare, w2, "c3", { query: "kobe" })).toMatchObject({
      ok: false,
      error: { code: "not_allowed" },
    });
    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await fx.admin.query<{ target: { reason: string } }>(
      `SELECT target FROM audit_log WHERE action = 'sandbox.web_search_refused' AND team_id = ANY($1)`,
      [[w.team, w2.team]],
    );
    expect(rows.map((r) => r.target.reason).sort()).toEqual(
      ["capability_missing", "input_mismatch", "not_allowed"].sort(),
    );
    expect(JSON.stringify(rows)).not.toContain("kobe");
  });
});
