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
import { threadUsageResponseSchema } from "./openapi/usage.js";
import { createTeamWithAdmin } from "./teams/members.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-43: catalog prices, the run_usage ledger's dashboards (team admin, site admin) and the
 * per-run / per-thread usage the chat shows. Rows are written with the shim's own writer
 * (`recordModelUsage`), as the model-gateway does.
 */
let h: Harness;
const ids = { siteAdmin: "", alice: "", bob: "", dave: "" };
let as: Record<keyof typeof ids, TestBrowser>;
let finance = "";
let marketing = "";
let bobRun = "";
let bobThread = "";

const asUser = <T>(userId: string, fn: () => Promise<T>) =>
  runWithAuditContext({ actor: { kind: "user", id: userId }, ip: null, userAgent: null }, fn);

const MODELS = "/v1/site/models";
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
  ids.siteAdmin = await h.createUser("admin@usage.test", "admin");
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
    siteAdmin: await h.signIn("admin@usage.test"),
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
        userEntryId: "e-prompt",
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .returning({ id: runs.id });
    if (!run) throw new Error("no run");
    return { runId: run.id, threadId: thread.id };
  }));
}, 120_000);
afterAll(() => h.close());

describe("catalog prices (site admin)", () => {
  it("sets, shows, changes and clears prices; the audit says prices changed, not the amounts", async () => {
    const p = await as.siteAdmin.post(`${MODELS}/providers`, {
      kind: "openai_compatible",
      id: "usage",
      name: "Usage",
      base_url: "http://usage.lan:8000/v1",
    });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    const add = await as.siteAdmin.post(`${MODELS}/catalog`, {
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
    const bad = await as.siteAdmin.patch(`${MODELS}/catalog/usage-m1`, {
      output_usd_per_mtok: -1,
    });
    expect(bad.status).toBe(400);
    // KOBE-43 review: prices come as a set (input and output together; cache only with them).
    const partial = await as.siteAdmin.patch(`${MODELS}/catalog/usage-m1`, {
      output_usd_per_mtok: null,
    });
    expect(partial.status).toBe(400);
    expect(partial.json.code).toBe("partial_prices");
    const cacheOnly = await as.siteAdmin.post(`${MODELS}/catalog`, {
      alias: "usage-cache-only",
      provider_id: "usage",
      model: "m2",
      cache_read_usd_per_mtok: 0.1,
    });
    expect(cacheOnly.json.code).toBe("partial_prices");
    const cleared = await as.siteAdmin.patch(`${MODELS}/catalog/usage-m1`, {
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

  it("site admins see every team's usage summed and per team; team admins cannot", async () => {
    const r = await as.siteAdmin.get("/v1/site/usage");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.totals.calls).toBe(4);
    expect(r.json.by_team.map((t: { name: string; calls: number }) => [t.name, t.calls])).toEqual([
      ["Finance", 3],
      ["Marketing", 1],
    ]);
    expect((await as.alice.get("/v1/site/usage")).status).toBe(403);
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
    // KOBE-208: the run's prompt entry, so the chat can put each run's usage under its answer.
    expect(thread.json.runs[0]).toMatchObject({ run_id: bobRun, user_entry_id: "e-prompt" });
    expect((await as.dave.get(`/v1/runs/${bobRun}/usage`)).status).toBe(404);
    expect((await as.dave.get(`/v1/threads/${bobThread}/usage`)).status).toBe(404);
  });
});

describe("site breakdowns across teams (KOBE-43 review)", () => {
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
    const r = await as.siteAdmin.get("/v1/site/usage");
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

describe("the thread's latest model call (KOBE-211, the context gauge)", () => {
  const newThread = () =>
    withTeam(h.deps.database.db, finance, async (tx) => {
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
      return { threadId: thread.id, runId: run.id };
    });

  it("answers the newest call's prompt tokens (input, cache read, cache write), skipping calls without input", async () => {
    const { threadId, runId } = await newThread();
    const t0 = Date.now() - 60_000;
    await recordModelUsage(h.deps.database.db, [
      usage({ runId, at: new Date(t0), inputTokens: 90_000, cacheReadTokens: 0 }),
      // OpenAI-style: cached tokens split out of the prompt by the gateway.
      usage({ runId, at: new Date(t0 + 10_000), inputTokens: 2_000, cacheReadTokens: 140_000 }),
      // Anthropic-style: the whole prompt written to the cache, none of it plain input.
      usage({
        runId,
        at: new Date(t0 + 20_000),
        model: "kobe-usage/m2",
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 150_000,
      }),
      // A call refused before the provider read anything: no input, so not the context's size.
      usage({ runId, at: new Date(t0 + 30_000), status: 502, inputTokens: 0, outputTokens: 0 }),
    ]);
    const r = await as.bob.get(`/v1/threads/${threadId}/usage`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.latest_call).toEqual({
      run_id: runId,
      at: new Date(t0 + 20_000).toISOString(),
      model: "kobe-usage/m2",
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 150_000,
    });
    expect(threadUsageResponseSchema.safeParse(r.json).error).toBeUndefined();
  });

  it("is visible like the thread: a project reader once shared, never a member it isn't shared with", async () => {
    const db = h.deps.database.db;
    const reader = await h.createUser("carol@usage.test");
    const outsider = await h.createUser("erin@usage.test");
    await withTeam(db, finance, (tx) =>
      tx.insert(teamMembers).values([
        { teamId: finance, userId: reader, role: "member" },
        { teamId: finance, userId: outsider, role: "member" },
      ]),
    );
    const browsers = {
      reader: await h.signIn("carol@usage.test"),
      outsider: await h.signIn("erin@usage.test"),
    };
    for (const b of Object.values(browsers)) {
      expect((await b.put("/v1/me/teams/active", { teamId: finance })).status).toBe(200);
      b.team = finance;
    }
    const project = await as.alice.post("/v1/projects", {
      name: "Usage shared",
      members_mode: "selected",
      member_user_ids: [reader],
    });
    expect(project.status, JSON.stringify(project.json)).toBe(201);
    const made = await as.alice.post("/v1/threads", { project_id: project.json.id });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const threadId = made.json.thread_id as string;
    const [run] = await withTeam(db, finance, (tx) =>
      tx
        .insert(runs)
        .values({
          teamId: finance,
          threadId,
          trigger: "user",
          status: "completed",
          startedAt: new Date(),
          endedAt: new Date(),
        })
        .returning({ id: runs.id }),
    );
    await recordModelUsage(db, [usage({ runId: run?.id, userId: ids.alice, inputTokens: 5_000 })]);
    const url = `/v1/threads/${threadId}/usage`;

    // In the project but not shared yet: the reader can't see it.
    expect((await browsers.reader.get(url)).status).toBe(404);
    const shared = await as.alice.post(`/v1/threads/${threadId}/share`, { visibility: "project" });
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);
    const seen = await browsers.reader.get(url);
    expect(seen.status, JSON.stringify(seen.json)).toBe(200);
    expect(seen.json.latest_call).toMatchObject({ run_id: run?.id, input_tokens: 5_000 });
    // A team member outside the project never sees it.
    const hidden = await browsers.outsider.get(url);
    expect(hidden.status).toBe(404);
    expect(hidden.json.code).toBe("thread_not_found");
  });

  it("is null before the thread's first model call", async () => {
    const { threadId } = await newThread();
    const r = await as.bob.get(`/v1/threads/${threadId}/usage`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ runs: [], latest_call: null });
    expect(threadUsageResponseSchema.safeParse(r.json).error).toBeUndefined();
  });
});
