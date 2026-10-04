import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  recordModelUsage,
  runs,
  teamMembers,
  threads,
  withTeam,
  type ModelUsageRecord,
} from "@kobe/db";
import { runWithAuditContext } from "./audit/context.js";
import { createTeamWithAdmin } from "./teams/members.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-43: catalog prices, the run_usage ledger's dashboards (team admin, install admin) and the
 * per-run / per-thread usage the chat shows. Rows are written with the shim's own writer
 * (`recordModelUsage`), as the model-gateway does.
 */
let h: Harness;
const ids = { installAdmin: "", alice: "", bob: "", dave: "" };
let as: Record<keyof typeof ids, TestBrowser>;
let finance = "";
let marketing = "";
let bobRun = "";
let bobThread = "";

const asUser = <T>(userId: string, fn: () => Promise<T>) =>
  runWithAuditContext({ actor: { kind: "user", id: userId }, ip: null, userAgent: null }, fn);

const MODELS = "/v1/install/models";
const GW = "kobe-usage/m1";

const usage = (over: Partial<ModelUsageRecord>): ModelUsageRecord => ({
  id: randomUUID(),
  teamId: finance,
  userId: ids.bob,
  sandboxId: randomUUID(),
  runId: undefined,
  at: new Date(),
  route: "openai",
  model: GW,
  status: 200,
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  usageSource: "reported",
  durationMs: 900,
  ttfbMs: 100,
  aborted: false,
  ...over,
});

beforeAll(async () => {
  h = await openHarness({ models: { providerKeySecrets: ["p".repeat(40)] } });
  ids.installAdmin = await h.createUser("admin@usage.test", "admin");
  ids.alice = await h.createUser("alice@usage.test");
  ids.bob = await h.createUser("bob@usage.test");
  ids.dave = await h.createUser("dave@usage.test");
  const db = h.deps.database.db;
  finance = (
    await asUser(ids.alice, () =>
      createTeamWithAdmin(db, { slug: "u-finance", name: "Finance" }, ids.alice),
    )
  ).id;
  marketing = (
    await asUser(ids.dave, () =>
      createTeamWithAdmin(db, { slug: "u-marketing", name: "Marketing" }, ids.dave),
    )
  ).id;
  await withTeam(db, finance, (tx) =>
    tx.insert(teamMembers).values({ teamId: finance, userId: ids.bob, role: "member" }),
  );
  as = {
    installAdmin: await h.signIn("admin@usage.test"),
    alice: await h.signIn("alice@usage.test"),
    bob: await h.signIn("bob@usage.test"),
    dave: await h.signIn("dave@usage.test"),
  };
  for (const [who, team] of [
    ["alice", finance],
    ["bob", finance],
    ["dave", marketing],
  ] as const) {
    const res = await as[who].put("/v1/me/teams/active", { teamId: team });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    as[who].team = team;
  }
  ({ runId: bobRun, threadId: bobThread } = await withTeam(db, finance, async (tx) => {
    const [thread] = await tx
      .insert(threads)
      .values({ teamId: finance, ownerUserId: ids.bob })
      .returning({ id: threads.id });
    if (!thread) throw new Error("no thread");
    const [run] = await tx
      .insert(runs)
      .values({
        teamId: finance,
        threadId: thread.id,
        trigger: "user",
        status: "completed",
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .returning({ id: runs.id });
    if (!run) throw new Error("no run");
    return { runId: run.id, threadId: thread.id };
  }));
}, 120_000);
afterAll(() => h.close());

describe("catalog prices (install admin)", () => {
  it("sets, shows, changes and clears prices; the audit says prices changed, not the amounts", async () => {
    const p = await as.installAdmin.post(`${MODELS}/providers`, {
      kind: "openai_compatible",
      id: "usage",
      name: "Usage",
      base_url: "http://usage.lan:8000/v1",
    });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    const add = await as.installAdmin.post(`${MODELS}/catalog`, {
      alias: "usage-m1",
      provider_id: "usage",
      model: "m1",
      input_usd_per_mtok: 3,
      output_usd_per_mtok: 15,
    });
    expect(add.status, JSON.stringify(add.json)).toBe(201);
    expect(add.json.model).toMatchObject({
      gateway_model: GW,
      input_usd_per_mtok: 3,
      output_usd_per_mtok: 15,
      cache_read_usd_per_mtok: null,
    });
    const bad = await as.installAdmin.patch(`${MODELS}/catalog/usage-m1`, {
      output_usd_per_mtok: -1,
    });
    expect(bad.status).toBe(400);
    // KOBE-43 review: prices come as a set (input and output together; cache only with them).
    const partial = await as.installAdmin.patch(`${MODELS}/catalog/usage-m1`, {
      output_usd_per_mtok: null,
    });
    expect(partial.status).toBe(400);
    expect(partial.json.code).toBe("partial_prices");
    const cacheOnly = await as.installAdmin.post(`${MODELS}/catalog`, {
      alias: "usage-cache-only",
      provider_id: "usage",
      model: "m2",
      cache_read_usd_per_mtok: 0.1,
    });
    expect(cacheOnly.json.code).toBe("partial_prices");
    const cleared = await as.installAdmin.patch(`${MODELS}/catalog/usage-m1`, {
      cache_read_usd_per_mtok: 0.3,
      label: "M1",
    });
    expect(cleared.json.model).toMatchObject({ cache_read_usd_per_mtok: 0.3, label: "M1" });
    const { rows } = await h.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE action = 'models.catalog.changed' ORDER BY seq`,
    );
    expect(rows.map((r) => r.target.pricesChanged)).toEqual([true, true]);
    expect(JSON.stringify(rows)).not.toContain("15");
  });
});

describe("dashboards", () => {
  beforeAll(async () => {
    const db = h.deps.database.db;
    await recordModelUsage(db, [
      usage({ runId: bobRun }),
      usage({ runId: bobRun, usageSource: "estimated", inputTokens: 10, outputTokens: 10 }),
      usage({ userId: ids.alice, model: "kobe-usage/unpriced" }),
      usage({ teamId: marketing, userId: ids.dave }),
    ]);
  });

  it("team admins see their team's usage by user, model and time; never another team's", async () => {
    const r = await as.alice.get("/v1/team/usage");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.range.bucket).toBe("day");
    expect(r.json.totals).toMatchObject({ calls: 3, unpriced_calls: 1, estimated_calls: 1 });
    // $3 + $1.5 for each priced 1M-in/100k-out call, plus the tiny estimated one.
    expect(r.json.totals.cost_usd).toBeCloseTo(4.5 + (10 * 3 + 10 * 15) / 1e6, 9);
    expect(r.json.by_user.map((u: { email: string }) => u.email).sort()).toEqual([
      "alice@usage.test",
      "bob@usage.test",
    ]);
    expect(r.json.by_model.map((m: { model: string }) => m.model).sort()).toEqual([
      GW,
      "kobe-usage/unpriced",
    ]);
    expect(r.json.series).toHaveLength(1);
    expect(r.json.by_agent).toEqual([expect.objectContaining({ agent_id: null, calls: 3 })]);
  });

  it("members cannot open the team dashboard; ranges are validated", async () => {
    expect((await as.bob.get("/v1/team/usage")).status).toBe(403);
    expect(
      (await as.alice.get("/v1/team/usage?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z"))
        .status,
    ).toBe(400);
    expect((await as.alice.get("/v1/team/usage?from=2020-01-01T00:00:00Z")).status).toBe(400);
    expect((await as.alice.get("/v1/team/usage?bucket=minute")).status).toBe(400);
    const hourly = await as.alice.get(
      `/v1/team/usage?from=${new Date(Date.now() - 3600_000).toISOString()}`,
    );
    expect(hourly.json.range.bucket).toBe("hour");
  });

  it("install admins see every team's usage summed and per team; team admins cannot", async () => {
    const r = await as.installAdmin.get("/v1/install/usage");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.totals.calls).toBe(4);
    expect(r.json.by_team.map((t: { name: string; calls: number }) => [t.name, t.calls])).toEqual([
      ["Finance", 3],
      ["Marketing", 1],
    ]);
    expect((await as.alice.get("/v1/install/usage")).status).toBe(403);
  });

  it("the thread's owner sees per-run and per-thread usage; another team's member does not", async () => {
    const run = await as.bob.get(`/v1/runs/${bobRun}/usage`);
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    expect(run.json).toMatchObject({
      run_id: bobRun,
      calls: 2,
      input_tokens: 1_000_010,
      models: [GW],
    });
    const thread = await as.bob.get(`/v1/threads/${bobThread}/usage`);
    expect(thread.json.totals.calls).toBe(2);
    expect(thread.json.runs).toHaveLength(1);
    expect((await as.dave.get(`/v1/runs/${bobRun}/usage`)).status).toBe(404);
    expect((await as.dave.get(`/v1/threads/${bobThread}/usage`)).status).toBe(404);
  });
});

describe("install breakdowns across teams (KOBE-43 review)", () => {
  it("merge every team's full groups before limiting, so a model outside each team's top 50 still totals", async () => {
    const db = h.deps.database.db;
    const bulk = (teamId: string, userId: string, prefix: string) =>
      Array.from({ length: 50 }, (_, i) =>
        usage({
          teamId,
          userId,
          model: `kobe-usage/${prefix}-${i}`,
          inputTokens: 1_000,
          outputTokens: 0,
        }),
      );
    const shared = (teamId: string, userId: string) =>
      usage({
        teamId,
        userId,
        model: "kobe-usage/shared",
        inputTokens: 600,
        outputTokens: 0,
      });
    await recordModelUsage(db, [
      ...bulk(finance, ids.bob, "f"),
      shared(finance, ids.bob),
      ...bulk(marketing, ids.dave, "g"),
      shared(marketing, ids.dave),
    ]);
    const r = await as.installAdmin.get("/v1/install/usage");
    expect(r.status).toBe(200);
    expect(r.json.by_model).toHaveLength(50);
    const top = r.json.by_model.find((m: { model: string }) => m.model === "kobe-usage/shared");
    expect(top).toMatchObject({ model: "kobe-usage/shared", calls: 2, input_tokens: 1_200 });
    expect(typeof top.cost_usd_exact).toBe("string");
  });

  it("returns costs as exact numeric text", async () => {
    const r = await as.alice.get("/v1/team/usage");
    expect(r.json.totals.cost_usd_exact).toMatch(/^\d+\.\d{10}$/);
  });
});
