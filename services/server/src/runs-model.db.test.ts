import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { FAILURE_MESSAGES } from "./runs/failure-codes.js";
import { PINNED_AGENTS } from "./runs/agents.js";
import { startedModelAlias } from "./runs/lifecycle.js";
import { apiForKind, resolveRunModel } from "./runs/models.js";
import { RunFixture } from "./testing/run-fixture.js";

/**
 * KOBE-41 on the server: the run's model is resolved from the team's catalog into `run.start`
 * (the sandbox has no user session), a run without one is failed by the sandbox agent with the
 * server's message, and a run whose model call failed ends `run.failed` and lets the queue move.
 */
const f = new RunFixture();
/** Threads whose (fake) agent pins a model alias — what KOBE-47's resolver will supply. */
const pinnedAliases = new Map<string, string>();

/** Site defaults (chart values, KOBE-259): what a model without catalog limits gets. */
const TOKEN_DEFAULTS = {
  maxOutputTokens: 12_000,
  reasoningMaxOutputTokens: 48_000,
  contextWindow: 100_000,
};

beforeAll(async () => {
  await f.setup({
    modelTokenDefaults: TOKEN_DEFAULTS,
    agents: {
      async resolve(tx, input) {
        const resolved = await PINNED_AGENTS.resolve(tx, input);
        const alias = pinnedAliases.get(input.threadId);
        return resolved.ok && alias !== undefined
          ? { ...resolved, config: { model: { alias } } }
          : resolved;
      },
    },
  });
});

afterAll(async () => {
  await f.teardown();
});

/** Site catalog rows and the team's choice, as the admin API would leave them. */
async function catalog(
  team: string,
  ownerId: string,
  enabled: { alias: string; isDefault: boolean }[],
) {
  const admin = f.fx.admin;
  for (const [id, kind] of [
    ["openai", "openai"],
    ["anthropic", "anthropic"],
    ["gemini", "gemini"],
    ["vllm", "openai_compatible"],
  ] as const) {
    // Keyed kinds carry a sealed key (opaque here: nothing in these tests opens it).
    await admin.query(
      `INSERT INTO model_providers (id, kind, name, base_url, api_key_enc, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [
        id,
        kind,
        id,
        kind === "openai_compatible" ? "https://vllm.example" : null,
        kind === "openai_compatible" ? null : "v2.test.sealed-provider-key",
        ownerId,
      ],
    );
  }
  for (const [alias, provider, model] of [
    ["fast", "openai", "gpt-fake"],
    ["smart", "anthropic", "claude-fake"],
    ["gem", "gemini", "gemini-fake"],
    ["qwen", "vllm", "qwen-fake"],
  ] as const) {
    await admin.query(
      `INSERT INTO model_catalog (alias, provider_id, model, created_by)
       VALUES ($1, $2, $3, $4) ON CONFLICT (alias) DO NOTHING`,
      [alias, provider, model, ownerId],
    );
  }
  for (const e of enabled) {
    await admin.query(
      `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, $2, $3, $4)`,
      [team, e.alias, e.isDefault, ownerId],
    );
  }
}

describe("run model resolution (D30)", () => {
  it("uses the requested alias when the team enabled it; refuses one the team did not; the default only when none is requested", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [
      { alias: "fast", isDefault: true },
      { alias: "smart", isDefault: false },
      { alias: "gem", isDefault: false },
      { alias: "qwen", isDefault: false },
    ]);
    const db = f.fx.replica(0).deps.database.db;
    const resolve = (alias?: string) =>
      withTeam(db, w.team, (tx) => resolveRunModel(tx, w.team, alias));
    expect(await resolve("smart")).toEqual({
      ok: true,
      model: { alias: "smart", gateway_model: "anthropic/claude-fake", api: "anthropic-messages" },
      limits: { maxOutputTokens: null, contextWindow: null, reasoning: false },
      thinking: {
        site: { control: "none", allowed: false, default: null, max: null },
        teamMax: null,
      },
    });
    expect(await resolve("gem")).toMatchObject({
      model: { gateway_model: "gemini/gemini-fake", api: "google-generative-ai" },
    });
    expect(await resolve("qwen")).toMatchObject({
      model: { gateway_model: "kobe-vllm/qwen-fake", api: "openai-completions" },
    });
    expect(await resolve(undefined)).toMatchObject({
      model: { alias: "fast", gateway_model: "openai/gpt-fake" },
    });
    // User decision: a requested alias the team did not enable fails, never falls back.
    expect(await resolve("not-in-catalog")).toEqual({
      ok: false,
      code: "agent_model_not_enabled",
      alias: "not-in-catalog",
    });
    // Another team enabled nothing: no default, no leak of this team's choice (RLS), and its
    // request for this team's alias is refused too.
    const other = await f.world();
    expect(
      await withTeam(db, other.team, (tx) => resolveRunModel(tx, other.team, undefined)),
    ).toEqual({ ok: true, model: undefined });
    expect(
      await withTeam(db, other.team, (tx) => resolveRunModel(tx, other.team, "fast")),
    ).toMatchObject({ ok: false, alias: "fast" });
    expect(apiForKind("ollama")).toBe("openai-completions");
  });

  it("puts the resolved model into run.start and run.started (never a URL or a key)", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [{ alias: "smart", isDefault: true }]);
    const ws = await f.connect(w, 0);
    const threadId = await f.thread(w.owner);
    const runId = await f.message(w.owner, threadId, "hello");
    const start = await ws.started(runId);
    expect(start.config).toEqual({
      model: { alias: "smart", gateway_model: "anthropic/claude-fake", api: "anthropic-messages" },
      // KOBE-259: no catalog limits, not a reasoning model: the site defaults.
      model_limits: { max_output_tokens: 12_000, context_window: 100_000 },
      agent: null,
      approval_mode: "ask-on-write",
    });
    expect(JSON.stringify(start)).not.toMatch(/https?:|api_key|secret/);
    const [started] = await f.events(w.team, runId);
    expect(started).toMatchObject({ type: "run.started", payload: { model: "smart" } });
    // A re-sent start (recovery) reuses the alias the run started with.
    const db = f.fx.replica(0).deps.database.db;
    expect(await withTeam(db, w.team, (tx) => startedModelAlias(tx, w.team, runId))).toBe("smart");
    ws.reply(start, "hi");
    await f.until(w.team, runId, "completed");
  });

  it("run.start carries the catalog's limits, else the defaults: higher for reasoning models (KOBE-259)", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [
      { alias: "fast", isDefault: true },
      { alias: "smart", isDefault: false },
      { alias: "gem", isDefault: false },
      { alias: "qwen", isDefault: false },
    ]);
    const admin = f.fx.admin;
    const set = (alias: string, sql: string, values: unknown[]) =>
      admin.query(`UPDATE model_catalog SET ${sql} WHERE alias = $1`, [alias, ...values]);
    await set("smart", "max_output_tokens = $2, context_window = $3", [64_000, 200_000]);
    await set("gem", "reasoning = true", []);
    await set("qwen", "reasoning = true, context_window = $2", [32_768]);
    const ws = await f.connect(w, 0);
    const limits = async (alias: string) => {
      const threadId = await f.thread(w.owner);
      await admin.query(`UPDATE threads SET model_alias = $1 WHERE id = $2`, [alias, threadId]);
      const runId = await f.message(w.owner, threadId, `limits ${alias}`);
      const start = await ws.started(runId);
      ws.reply(start, "ok");
      await f.until(w.team, runId, "completed");
      return start.config?.model_limits;
    };
    try {
      // Catalog values win.
      expect(await limits("smart")).toEqual({ max_output_tokens: 64_000, context_window: 200_000 });
      // A reasoning model without its own limit gets the reasoning default.
      expect(await limits("gem")).toEqual({ max_output_tokens: 48_000, context_window: 100_000 });
      // A default that would fill a small window set in the catalog: half the window.
      expect(await limits("qwen")).toEqual({ max_output_tokens: 16_384, context_window: 32_768 });
      // Neither: the plain default.
      expect(await limits("fast")).toEqual({ max_output_tokens: 12_000, context_window: 100_000 });
    } finally {
      await set("smart", "max_output_tokens = NULL, context_window = NULL", []);
      await set("gem", "reasoning = false", []);
      await set("qwen", "reasoning = false, context_window = NULL", []);
    }
  });

  it("a conversation picks a thinking level; each run is clamped to the site and team settings (KOBE-260 ac-2)", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [
      { alias: "fast", isDefault: true },
      { alias: "qwen", isDefault: false },
    ]);
    const admin = f.fx.admin;
    const site = (sql: string) =>
      admin.query(`UPDATE model_catalog SET ${sql} WHERE alias = 'qwen'`);
    const teamMax = (level: string | null) =>
      admin.query(
        `UPDATE team_models SET thinking_max = $1 WHERE team_id = $2 AND alias = 'qwen'`,
        [level, w.team],
      );
    await site(`reasoning = true, thinking_control = 'reasoning_effort', thinking_allowed = true,
      thinking_default = 'low', thinking_max = 'medium'`);
    const owner = f.on(0, w.owner);
    const ws = await f.connect(w, 0);
    const created = await owner.post("/v1/threads", { title: "t", model: "qwen" });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const threadId = created.json.thread_id as string;
    expect(created.json.thinking_level).toBeNull();
    /** One run: its run.start level, run.started level and recorded level. */
    const run = async () => {
      const runId = await f.message(w.owner, threadId, "think");
      const start = await ws.started(runId);
      ws.reply(start, "ok");
      await f.until(w.team, runId, "completed");
      const [started] = await f.events(w.team, runId);
      const { rows } = await admin.query<{ thinking_level: string | null }>(
        `SELECT thinking_level FROM runs WHERE id = $1`,
        [runId],
      );
      const level = start.config?.thinking_level;
      expect((started?.payload as { thinking_level?: string }).thinking_level).toBe(level);
      expect(rows[0]?.thinking_level ?? undefined).toBe(level);
      return level;
    };
    const choose = async (level: string | null) => {
      const r = await owner.patch(`/v1/threads/${threadId}`, { thinking_level: level });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json.thinking_level).toBe(level);
    };
    try {
      // No choice: the model's default.
      expect(await run()).toBe("low");
      // A choice above the site's maximum is kept on the thread but clamped for the run.
      await choose("high");
      expect((await owner.get(`/v1/threads/${threadId}`)).json.thinking_level).toBe("high");
      expect(await run()).toBe("medium");
      await choose("off");
      expect(await run()).toBe("off");
      // The team narrows it further.
      await choose("high");
      await teamMax("low");
      expect(await run()).toBe("low");
      await teamMax("off");
      expect(await run()).toBe("off");
      await teamMax(null);
      // The site turns thinking off: every run is off.
      await site(`thinking_allowed = false, thinking_default = NULL, thinking_max = NULL`);
      expect(await run()).toBe("off");
      // A model without a thinking control: no level at all.
      await owner.patch(`/v1/threads/${threadId}`, { model: "fast" });
      expect(await run()).toBeUndefined();
      // Only levels are accepted.
      for (const bad of ["max", "xhigh", 3]) {
        const r = await owner.patch(`/v1/threads/${threadId}`, { thinking_level: bad });
        expect(r.status, String(bad)).toBe(400);
      }
    } finally {
      await site(`thinking_control = 'none', thinking_allowed = false, thinking_default = NULL,
        thinking_max = NULL, reasoning = false`);
    }
  });

  it("an agent pinned to a model the team did not enable fails the run naming the model (user decision)", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [{ alias: "fast", isDefault: true }]);
    const ws = await f.connect(w, 0);
    const threadId = await f.thread(w.owner);
    pinnedAliases.set(threadId, "smart");
    const runId = await f.message(w.owner, threadId, "hello");
    await f.until(w.team, runId, "failed");
    expect(await f.types(w.team, runId)).toEqual(["run.failed"]);
    expect((await f.events(w.team, runId)).at(-1)?.payload).toEqual({
      error: {
        code: "agent_model_not_enabled",
        message:
          "This agent's model (smart) isn't enabled for your team. Ask your team admin to enable it.",
      },
    });
    expect(ws.starts().map((s) => s.run_id)).not.toContain(runId); // nothing was woken for it
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");
    // Enabling it makes the next message run on exactly that model.
    await f.fx.admin.query(
      `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'smart', false, $2)`,
      [w.team, w.owner.id],
    );
    const second = await f.message(w.owner, threadId, "again");
    const start = await ws.started(second);
    expect(start.config).toMatchObject({
      model: { alias: "smart", gateway_model: "anthropic/claude-fake" },
    });
    ws.reply(start, "ok");
    await f.until(w.team, second, "completed");
  });

  it("a team without models: run.start carries none, and the agent's refusal fails the run with the server's text", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0);
    const inner = ws.sb.respond;
    ws.sb.respond = (frame) =>
      frame.type === "run.start"
        ? {
            v: 1,
            type: "command.result",
            command_id: frame.command_id,
            ok: false,
            error: { code: "model_not_configured", message: "sandbox text <b>never shown</b>" },
          }
        : inner?.(frame);
    const threadId = await f.thread(w.owner);
    const runId = await f.message(w.owner, threadId, "hello");
    const start = await ws.started(runId);
    expect(start.config).toEqual({ agent: null, approval_mode: "ask-on-write" });
    await f.until(w.team, runId, "failed");
    const failed = (await f.events(w.team, runId)).at(-1);
    expect(failed).toMatchObject({
      type: "run.failed",
      payload: {
        error: { code: "model_not_configured", message: FAILURE_MESSAGES.model_not_configured },
      },
    });
    expect(JSON.stringify(failed)).not.toContain("never shown");
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");
  });

  it("a run whose model call failed ends run.failed and the queued message runs next", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [{ alias: "fast", isDefault: true }]);
    const ws = await f.connect(w, 0);
    const threadId = await f.thread(w.owner);
    const first = await f.message(w.owner, threadId, "one");
    const second = await f.message(w.owner, threadId, "two");
    const start = await ws.started(first);
    ws.event(start, { type: "agent_start" });
    ws.event(start, { type: "message_start", message: { role: "assistant" } });
    ws.event(start, {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "kobe.model_error:model_unavailable: model_access_pending after 6 attempts",
      },
    });
    ws.event(start, { type: "turn_end", message: { role: "assistant" } });
    ws.event(start, { type: "agent_settled" });
    await f.until(w.team, first, "failed");
    expect((await f.events(w.team, first)).at(-1)).toMatchObject({
      type: "run.failed",
      payload: {
        error: { code: "model_unavailable", message: FAILURE_MESSAGES.model_unavailable },
      },
    });
    const next = await ws.started(second);
    expect(next.config).toMatchObject({
      model: { alias: "fast", gateway_model: "openai/gpt-fake" },
    });
    ws.reply(next, "ok");
    await f.until(w.team, second, "completed");
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");
    expect(randomUUID()).toMatch(/-/); // keeps the import honest for the ids above
  });
});
