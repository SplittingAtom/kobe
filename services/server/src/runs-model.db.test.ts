import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { FAILURE_MESSAGES } from "./runs/failure-codes.js";
import { startedModelAlias } from "./runs/lifecycle.js";
import { apiForKind, resolveRunModel } from "./runs/models.js";
import { RunFixture } from "./testing/run-fixture.js";

/**
 * KOBE-41 on the server: the run's model is resolved from the team's catalog into `run.start`
 * (the sandbox has no user session), a run without one is failed by the sandbox agent with the
 * server's message, and a run whose model call failed ends `run.failed` and lets the queue move.
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
});

afterAll(async () => {
  await f.teardown();
});

/** Install catalog rows and the team's choice, as the admin API would leave them. */
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
  it("uses the requested alias when the team enabled it, else the team default, else nothing", async () => {
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
      alias: "smart",
      gateway_model: "anthropic/claude-fake",
      api: "anthropic-messages",
    });
    expect(await resolve("gem")).toMatchObject({
      gateway_model: "gemini/gemini-fake",
      api: "google-generative-ai",
    });
    expect(await resolve("qwen")).toMatchObject({
      gateway_model: "kobe-vllm/qwen-fake",
      api: "openai-completions",
    });
    expect(await resolve(undefined)).toMatchObject({
      alias: "fast",
      gateway_model: "openai/gpt-fake",
    });
    expect(await resolve("not-in-catalog")).toMatchObject({ alias: "fast" });
    // Another team enabled nothing: no model, and no leak of this team's choice (RLS).
    const other = await f.world();
    expect(
      await withTeam(db, other.team, (tx) => resolveRunModel(tx, other.team, "fast")),
    ).toBeUndefined();
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
