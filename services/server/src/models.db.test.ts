import pg from "pg";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MODELS_CHANNEL,
  PROVIDER_KEY_PURPOSE,
  SecretBox,
  VIRTUAL_KEY_PURPOSE,
  modelGatewayKeys,
  providerKeyContext,
  teamMembers,
  virtualKeyContext,
  withTeam,
} from "@kobe/db";
import { runWithAuditContext } from "./audit/context.js";
import { gatewayTeamName, virtualKeyName } from "./models/desired.js";
import { ModelGatewaySync } from "./models/sync.js";
import { teamModelsResponseSchema } from "./openapi/models.js";
import { FakeBifrost } from "./models/testing/fake-bifrost.js";
import { createTeamWithAdmin, removeMember } from "./teams/members.js";
import { deactivateUser } from "./users/deactivation.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-40: site model admin (providers with write-only keys, catalog), team enablement, audit,
 * and the gateway sync (Bifrost faked in memory; the real one is exercised by e2e and the
 * `bifrost.int.test.ts` check against a local binary).
 */
const PROVIDER_SECRET = "p".repeat(40);
/** Site defaults for models without catalog limits (chart values; KOBE-259). */
const TOKEN_DEFAULTS = {
  maxOutputTokens: 12_000,
  reasoningMaxOutputTokens: 48_000,
  contextWindow: 100_000,
};
const VK_SECRET = "v".repeat(40);
const providerBox = new SecretBox(PROVIDER_SECRET, PROVIDER_KEY_PURPOSE);
const vkBox = new SecretBox(VK_SECRET, VIRTUAL_KEY_PURPOSE);
const logger = pino({ level: "silent" });

let h: Harness;
const ids = { owner: "", siteAdmin: "", alice: "", bob: "", dave: "" };
let as: Record<keyof typeof ids, TestBrowser>;
let finance = "";
let marketing = "";

const asUser = <T>(userId: string, fn: () => Promise<T>) =>
  runWithAuditContext({ actor: { kind: "user", id: userId }, ip: null, userAgent: null }, fn);

async function audit(prefix: string) {
  const { rows } = await h.admin.query<{
    action: string;
    team_id: string | null;
    target: Record<string, unknown>;
  }>(`SELECT action, team_id, target FROM audit_log WHERE action LIKE $1 ORDER BY seq`, [
    `${prefix}%`,
  ]);
  return rows;
}

const newSync = (bifrost: FakeBifrost, intervalMs = 3_600_000) =>
  new ModelGatewaySync({
    db: h.deps.database.db,
    connectionString: h.appUrl,
    admin: bifrost,
    providerKeys: providerBox,
    virtualKeys: vkBox,
    fingerprintSecret: PROVIDER_SECRET,
    logger,
    intervalMs,
    leaderRetryMs: 200,
    debounceMs: 20,
  });

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  h = await openHarness({
    models: { providerKeySecrets: [PROVIDER_SECRET] },
    modelTokenDefaults: TOKEN_DEFAULTS,
  });
  ids.owner = await h.createUser("owner@models.test", "owner");
  ids.siteAdmin = await h.createUser("admin@models.test", "admin");
  ids.alice = await h.createUser("alice@models.test");
  ids.bob = await h.createUser("bob@models.test");
  ids.dave = await h.createUser("dave@models.test");
  const db = h.deps.database.db;
  finance = (
    await asUser(ids.alice, () =>
      createTeamWithAdmin(db, { slug: "finance", name: "Finance" }, ids.alice),
    )
  ).id;
  marketing = (
    await asUser(ids.dave, () =>
      createTeamWithAdmin(db, { slug: "marketing", name: "Marketing" }, ids.dave),
    )
  ).id;
  await withTeam(db, finance, (tx) =>
    tx.insert(teamMembers).values({ teamId: finance, userId: ids.bob, role: "member" }),
  );
  as = {
    owner: await h.signIn("owner@models.test"),
    siteAdmin: await h.signIn("admin@models.test"),
    alice: await h.signIn("alice@models.test"),
    bob: await h.signIn("bob@models.test"),
    dave: await h.signIn("dave@models.test"),
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
}, 120_000);
afterAll(() => h.close());

const MODELS = "/v1/site/models";

describe("site providers", () => {
  it("is for site admins only", async () => {
    expect((await as.alice.get(MODELS)).status).toBe(403);
    expect(
      (await as.alice.post(`${MODELS}/providers`, { kind: "openai", name: "x", api_key: "k" }))
        .status,
    ).toBe(403);
  });

  it("stores the API key sealed, never returns or audits it", async () => {
    const res = await as.siteAdmin.post(`${MODELS}/providers`, {
      kind: "anthropic",
      name: "Anthropic",
      api_key: "  sk-ant-secret-0001  ",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.provider).toMatchObject({
      id: "anthropic",
      kind: "anthropic",
      key_set: true,
      key_revision: 1,
      gateway_provider: "anthropic",
    });
    expect(JSON.stringify(res.json)).not.toContain("sk-ant-secret");
    const { rows } = await h.admin.query<{ api_key_enc: string }>(
      "SELECT api_key_enc FROM model_providers WHERE id = 'anthropic'",
    );
    expect(rows[0]?.api_key_enc).not.toContain("sk-ant");
    expect(providerBox.open(rows[0]?.api_key_enc ?? "", providerKeyContext("anthropic", 1))).toBe(
      "sk-ant-secret-0001",
    );
    const listed = await as.siteAdmin.get(MODELS);
    expect(JSON.stringify(listed.json)).not.toContain("sk-ant-secret");
    const events = await audit("models.provider");
    expect(events.at(-1)).toMatchObject({
      action: "models.provider.added",
      team_id: null,
      target: {
        providerId: "anthropic",
        kind: "anthropic",
        keySet: true,
        privateNetwork: false,
        endpointHost: null,
      },
    });
    expect(JSON.stringify(events)).not.toContain("sk-ant-secret");
  });

  it("validates kinds: vendor ids, required keys and endpoints; no duplicates", async () => {
    for (const bad of [
      { kind: "openai", name: "x" },
      { kind: "openai", id: "my-openai", name: "x", api_key: "k" },
      { kind: "ollama", name: "x" },
      { kind: "openai_compatible", name: "x", base_url: "http://vllm:8000" },
      { kind: "openai_compatible", id: "v", name: "x", base_url: "http://u:p@vllm:8000" },
      { kind: "openai_compatible", id: "vllm", name: "x", base_url: "file:///etc/passwd" },
      { kind: "openai", name: "x", api_key: "has space" },
      { kind: "bedrock", name: "x", api_key: "k" },
    ]) {
      const r = await as.siteAdmin.post(`${MODELS}/providers`, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(JSON.stringify(r.json)).not.toContain("has space");
    }
    const dup = await as.siteAdmin.post(`${MODELS}/providers`, {
      kind: "anthropic",
      name: "Again",
      api_key: "k",
    });
    expect(dup.status).toBe(409);
  });

  it("adds keyless local providers and replaces a key (revision, audit says changed)", async () => {
    for (const body of [
      {
        kind: "ollama",
        name: "Ollama",
        base_url: "http://ollama.lan:11434/",
        allow_private_network: true,
      },
      {
        kind: "openai_compatible",
        id: "vllm",
        name: "vLLM",
        base_url: "http://vllm.lan:8000/v1",
        allow_private_network: true,
      },
      { kind: "openai", name: "OpenAI", api_key: "sk-openai-0001" },
      { kind: "gemini", name: "Gemini", api_key: "gem-0001" },
    ]) {
      const r = await as.siteAdmin.post(`${MODELS}/providers`, body);
      expect(r.status, JSON.stringify(r.json)).toBe(201);
    }
    const ollama = await as.siteAdmin.get(MODELS);
    const byId = Object.fromEntries(
      (ollama.json.providers as { id: string }[]).map((p) => [p.id, p]),
    );
    expect(byId.ollama).toMatchObject({ base_url: "http://ollama.lan:11434", key_set: false });
    expect(byId.vllm).toMatchObject({ gateway_provider: "kobe-vllm", key_set: false });

    const r = await as.siteAdmin.patch(`${MODELS}/providers/openai`, {
      api_key: "sk-openai-0002",
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.provider).toMatchObject({ key_set: true, key_revision: 2 });
    expect((await audit("models.provider.changed")).at(-1)?.target).toMatchObject({
      providerId: "openai",
      keyChanged: true,
      baseUrlChanged: false,
    });
    expect((await as.siteAdmin.patch(`${MODELS}/providers/openai`, { api_key: null })).status).toBe(
      400,
    );
    expect((await as.siteAdmin.patch(`${MODELS}/providers/nope`, { name: "x" })).status).toBe(404);
  });
});

describe("provider endpoints: a stored key never moves without being re-entered", () => {
  it("vendor providers keep their vendor's endpoint", async () => {
    const r = await as.siteAdmin.patch(`${MODELS}/providers/openai`, {
      base_url: "https://evil.example.com",
      api_key: "sk-openai-0002",
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("vendor_endpoint_fixed");
  });

  it("an endpoint change on a keyed provider needs the key again; never over plain http", async () => {
    const add = await as.siteAdmin.post(`${MODELS}/providers`, {
      kind: "openai_compatible",
      id: "together",
      name: "Together",
      base_url: "https://api.together.example",
      api_key: "tg-key-0001",
    });
    expect(add.status, JSON.stringify(add.json)).toBe(201);
    const moved = await as.siteAdmin.patch(`${MODELS}/providers/together`, {
      base_url: "https://attacker.example",
    });
    expect(moved.status).toBe(400);
    expect(moved.json.code).toBe("key_required_for_new_endpoint");
    const plain = await as.siteAdmin.patch(`${MODELS}/providers/together`, {
      base_url: "http://api2.together.example",
      api_key: "tg-key-0002",
    });
    expect(plain.json.code).toBe("insecure_endpoint");
    const ok = await as.siteAdmin.patch(`${MODELS}/providers/together`, {
      base_url: "https://api2.together.example",
      api_key: "tg-key-0002",
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await audit("models.provider.changed")).at(-1)?.target).toMatchObject({
      providerId: "together",
      keyChanged: true,
      baseUrlChanged: true,
      endpointHost: "api2.together.example",
    });
    const insecureAdd = await as.siteAdmin.post(`${MODELS}/providers`, {
      kind: "openai_compatible",
      id: "plainhttp",
      name: "x",
      base_url: "http://plain.example",
      api_key: "k-0001",
    });
    expect(insecureAdd.json.code).toBe("insecure_endpoint");
    expect((await as.siteAdmin.delete(`${MODELS}/providers/together`)).status).toBe(204);
  });
});

describe("catalog and team enablement", () => {
  it("publishes aliases with the gateway model id; a provider in use cannot be removed", async () => {
    for (const body of [
      { alias: "smart", provider_id: "anthropic", model: "claude-sonnet-4-5", label: "Smart" },
      { alias: "fast", provider_id: "openai", model: "gpt-5-mini" },
      { alias: "local", provider_id: "ollama", model: "llama3.3" },
      { alias: "qwen", provider_id: "vllm", model: "qwen/qwen3-8b" },
    ]) {
      const r = await as.siteAdmin.post(`${MODELS}/catalog`, body);
      expect(r.status, JSON.stringify(r.json)).toBe(201);
    }
    const list = await as.siteAdmin.get(MODELS);
    const qwen = (list.json.catalog as { alias: string; gateway_model: string }[]).find(
      (c) => c.alias === "qwen",
    );
    expect(qwen?.gateway_model).toBe("kobe-vllm/qwen/qwen3-8b");
    expect(
      (
        await as.siteAdmin.post(`${MODELS}/catalog`, {
          alias: "x",
          provider_id: "nope",
          model: "m",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await as.siteAdmin.post(`${MODELS}/catalog`, {
          alias: "smart",
          provider_id: "openai",
          model: "m",
        })
      ).status,
    ).toBe(409);
    expect((await as.siteAdmin.delete(`${MODELS}/providers/vllm`)).status).toBe(409);
    expect((await audit("models.catalog")).map((e) => e.target.change)).toEqual([
      "added",
      "added",
      "added",
      "added",
    ]);
  });

  it("site admins set a model's input modalities; text is always kept (KOBE-191)", async () => {
    const add = await as.siteAdmin.post(`${MODELS}/catalog`, {
      alias: "vision",
      provider_id: "openai",
      model: "gpt-5-vision",
      input_modalities: ["image"],
    });
    expect(add.status, JSON.stringify(add.json)).toBe(201);
    expect(add.json.model.input_modalities).toEqual(["text", "image"]);
    const plain = await as.siteAdmin.get(MODELS);
    const find = (a: string) =>
      (plain.json.catalog as { alias: string; input_modalities: string[] }[]).find(
        (c) => c.alias === a,
      );
    expect(find("fast")?.input_modalities).toEqual(["text"]); // default
    expect(find("vision")?.input_modalities).toEqual(["text", "image"]);

    const off = await as.siteAdmin.patch(`${MODELS}/catalog/vision`, {
      input_modalities: ["text"],
    });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(off.json.model.input_modalities).toEqual(["text"]);
    const label = await as.siteAdmin.patch(`${MODELS}/catalog/vision`, { label: "V" });
    expect(label.json.model.input_modalities).toEqual(["text"]); // kept
    for (const bad of [["video"], "image", [1]]) {
      const r = await as.siteAdmin.patch(`${MODELS}/catalog/vision`, { input_modalities: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(
      (await as.bob.patch(`${MODELS}/catalog/vision`, { input_modalities: ["text", "image"] }))
        .status,
    ).toBe(403);
    expect((await as.siteAdmin.delete(`${MODELS}/catalog/vision`)).status).toBe(204);
  });

  it("site admins set a model's output limit, context window and reasoning flag (KOBE-259)", async () => {
    const listed = await as.siteAdmin.get(MODELS);
    // What a model without its own values gets (chart values), for the page to show.
    expect(listed.json.token_defaults).toEqual({
      max_output_tokens: 12_000,
      reasoning_max_output_tokens: 48_000,
      context_window: 100_000,
    });
    const add = await as.siteAdmin.post(`${MODELS}/catalog`, {
      alias: "thinker",
      provider_id: "openai",
      model: "o-fake",
    });
    expect(add.status, JSON.stringify(add.json)).toBe(201);
    expect(add.json.model).toMatchObject({
      reasoning: false,
      max_output_tokens: null,
      context_window: null,
    });
    const set = await as.siteAdmin.patch(`${MODELS}/catalog/thinker`, {
      reasoning: true,
      max_output_tokens: 65_536,
      context_window: 200_000,
    });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json.model).toMatchObject({
      reasoning: true,
      max_output_tokens: 65_536,
      context_window: 200_000,
    });
    // A new entry may carry them too; a too-large limit is refused before anything is written.
    const refused = await as.siteAdmin.post(`${MODELS}/catalog`, {
      alias: "thinker-2",
      provider_id: "openai",
      model: "o-fake-2",
      max_output_tokens: 8_192,
      context_window: 8_192,
    });
    expect(refused.json).toMatchObject({ code: "output_limit_exceeds_context" });
    // Cleared back to the defaults; the flag kept.
    const cleared = await as.siteAdmin.patch(`${MODELS}/catalog/thinker`, {
      max_output_tokens: null,
      context_window: null,
    });
    expect(cleared.status, JSON.stringify(cleared.json)).toBe(200);
    expect(cleared.json.model).toMatchObject({
      reasoning: true,
      max_output_tokens: null,
      context_window: null,
    });
    // The output limit must leave room for input: in the model's own window, else the default's.
    const tooBig = await as.siteAdmin.patch(`${MODELS}/catalog/thinker`, {
      max_output_tokens: 100_000,
    });
    expect(tooBig.status).toBe(400);
    expect(tooBig.json).toMatchObject({ code: "output_limit_exceeds_context" });
    expect(tooBig.json.message).toContain("100,000");
    const fits = await as.siteAdmin.patch(`${MODELS}/catalog/thinker`, {
      max_output_tokens: 100_000,
      context_window: 400_000,
    });
    expect(fits.status, JSON.stringify(fits.json)).toBe(200);
    for (const bad of [
      { max_output_tokens: 255 },
      { max_output_tokens: 131_073 },
      { max_output_tokens: 1.5 },
      { context_window: 1_023 },
      { context_window: 10_000_001 },
      { reasoning: "yes" },
    ]) {
      const r = await as.siteAdmin.patch(`${MODELS}/catalog/thinker`, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await as.bob.patch(`${MODELS}/catalog/thinker`, { reasoning: false })).status).toBe(
      403,
    );
    // The chat's catalog (team models) carries them too (KOBE-210 ac-2).
    const team = await as.bob.get("/v1/team/models");
    expect(
      (team.json.models as Record<string, unknown>[]).find((m) => m.alias === "thinker"),
    ).toMatchObject({ max_output_tokens: 100_000, context_window: 400_000, reasoning: true });
    // The documented shape (KOBE-210 ac-3): a blank context window is null, never absent.
    expect(teamModelsResponseSchema.safeParse(team.json).error).toBeUndefined();
    expect(
      (team.json.models as Record<string, unknown>[]).every((m) => "context_window" in m),
    ).toBe(true);
    const events = await audit("models.catalog");
    expect(events.at(-1)?.target).toMatchObject({ alias: "thinker", limitsChanged: true });
    expect((await as.siteAdmin.delete(`${MODELS}/catalog/thinker`)).status).toBe(204);
  });

  it("site admins set a model's thinking control, allowance, default and maximum (KOBE-260 ac-1)", async () => {
    const THINK = { control: "reasoning_effort", allowed: true, default: "low", max: "medium" };
    // Only for a reasoning model, and only a control that fits the provider.
    const notReasoning = await as.siteAdmin.post(`${MODELS}/catalog`, {
      alias: "glm",
      provider_id: "ollama",
      model: "glm-5.3",
      thinking: THINK,
    });
    expect(notReasoning.status).toBe(400);
    expect(notReasoning.json).toMatchObject({ code: "thinking_invalid" });
    expect(notReasoning.json.message).toContain("reasoning");
    const add = await as.siteAdmin.post(`${MODELS}/catalog`, {
      alias: "glm",
      provider_id: "ollama",
      model: "glm-5.3",
      reasoning: true,
      thinking: THINK,
    });
    expect(add.status, JSON.stringify(add.json)).toBe(201);
    expect(add.json.model.thinking).toEqual({ ...THINK, lowest: "off" });
    const wrongKind = await as.siteAdmin.patch(`${MODELS}/catalog/glm`, {
      thinking: { ...THINK, control: "anthropic_adaptive" },
    });
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.json.message).toContain("ollama");
    for (const bad of [
      { ...THINK, default: "high" }, // above the maximum
      { ...THINK, max: "off", default: "off" },
      { ...THINK, allowed: false }, // levels without thinking
      { ...THINK, max: null },
      { control: "none", allowed: true, default: null, max: null },
    ]) {
      const r = await as.siteAdmin.patch(`${MODELS}/catalog/glm`, { thinking: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.json).toMatchObject({ code: "thinking_invalid" });
    }
    for (const bad of [
      { ...THINK, control: "think" },
      { ...THINK, default: "max" },
      { ...THINK, extra: true },
      "on",
    ]) {
      const r = await as.siteAdmin.patch(`${MODELS}/catalog/glm`, { thinking: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    // Unmarking the reasoning flag needs the thinking control removed too.
    const unflag = await as.siteAdmin.patch(`${MODELS}/catalog/glm`, { reasoning: false });
    expect(unflag.json).toMatchObject({ code: "thinking_invalid" });
    // Thinking off for every run (the KOBE-258 case): persisted, audited, shown to teams.
    const off = { control: "reasoning_effort", allowed: false, default: null, max: null };
    const set = await as.siteAdmin.patch(`${MODELS}/catalog/glm`, { thinking: off });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    const stored = { ...off, lowest: "off" };
    expect((await as.siteAdmin.get(MODELS)).json.catalog).toEqual(
      expect.arrayContaining([expect.objectContaining({ alias: "glm", thinking: stored })]),
    );
    expect((await audit("models.catalog")).at(-1)?.target).toMatchObject({
      alias: "glm",
      thinking: stored,
    });
    // Models that cannot turn thinking off (review S2): known families default to low, an
    // explicit off for them is refused, and anthropic budgets are refused where Claude rejects them.
    const o3 = await as.siteAdmin.post(`${MODELS}/catalog`, {
      alias: "o3",
      provider_id: "openai",
      model: "o3",
      reasoning: true,
      thinking: THINK,
    });
    expect(o3.status, JSON.stringify(o3.json)).toBe(201);
    expect(o3.json.model.thinking).toMatchObject({ lowest: "low" });
    const o3Off = await as.siteAdmin.patch(`${MODELS}/catalog/o3`, {
      thinking: { ...THINK, lowest: "off" },
    });
    expect(o3Off.json).toMatchObject({ code: "thinking_invalid" });
    expect(o3Off.json.message).toContain("cannot turn thinking off");
    expect((await as.siteAdmin.delete(`${MODELS}/catalog/o3`)).status).toBe(204);
    // An admin's own "can't turn off" survives a PATCH that leaves `lowest` out (re-review R2).
    const lowSet = await as.siteAdmin.patch(`${MODELS}/catalog/glm`, {
      thinking: { ...THINK, lowest: "low" },
    });
    expect(lowSet.json.model?.thinking).toMatchObject({ lowest: "low" });
    const partial = await as.siteAdmin.patch(`${MODELS}/catalog/glm`, {
      thinking: { ...THINK, max: "high" },
    });
    expect(partial.status, JSON.stringify(partial.json)).toBe(200);
    expect(partial.json.model.thinking).toMatchObject({ max: "high", lowest: "low" });
    const budget = await as.siteAdmin.post(`${MODELS}/catalog`, {
      alias: "opus48",
      provider_id: "anthropic",
      model: "claude-opus-4-8",
      reasoning: true,
      thinking: { ...THINK, control: "anthropic_budget" },
    });
    expect(budget.json).toMatchObject({ code: "thinking_invalid" });
    expect(budget.json.message).toContain("refuses thinking budgets");
    // Anthropic models that cannot turn thinking off: always allowed, never off by default.
    const alwaysOn = await as.siteAdmin.post(`${MODELS}/catalog`, {
      alias: "opus",
      provider_id: "anthropic",
      model: "claude-opus-5-5",
      reasoning: true,
      thinking: { control: "anthropic_effort", allowed: false, default: null, max: null },
    });
    expect(alwaysOn.json).toMatchObject({ code: "thinking_invalid" });
    expect((await as.bob.patch(`${MODELS}/catalog/glm`, { thinking: off })).status).toBe(403);
    expect((await as.siteAdmin.delete(`${MODELS}/catalog/glm`)).status).toBe(204);
  });

  it("team admins can only narrow a model's thinking (KOBE-260 ac-4)", async () => {
    const add = await as.siteAdmin.post(`${MODELS}/catalog`, {
      alias: "deep",
      provider_id: "openai",
      model: "gpt-deep",
      reasoning: true,
      thinking: { control: "reasoning_effort", allowed: true, default: "medium", max: "medium" },
    });
    expect(add.status, JSON.stringify(add.json)).toBe(201);
    const deep = (r: { json: Record<string, unknown> }) =>
      (r.json.models as Record<string, unknown>[]).find((m) => m.alias === "deep");
    try {
      // Wider than the site: refused; equal or lower: kept.
      const wider = await as.alice.put("/v1/team/models/deep", {
        enabled: true,
        thinking_max: "high",
      });
      expect(wider.status).toBe(400);
      expect(wider.json).toMatchObject({ code: "thinking_invalid" });
      expect(deep(await as.alice.get("/v1/team/models"))).toMatchObject({ enabled: false });
      const lower = await as.alice.put("/v1/team/models/deep", {
        enabled: true,
        thinking_max: "low",
      });
      expect(lower.status, JSON.stringify(lower.json)).toBe(200);
      expect(teamModelsResponseSchema.safeParse(lower.json).error).toBeUndefined();
      expect(deep(lower)).toMatchObject({
        thinking_max: "low",
        // The site's default comes down to the team's maximum.
        thinking_in_team: { default: "low", levels: ["off", "low"] },
      });
      // Members read it; only team admins change it.
      expect(deep(await as.bob.get("/v1/team/models"))).toMatchObject({ thinking_max: "low" });
      expect(
        (await as.bob.put("/v1/team/models/deep", { enabled: true, thinking_max: "off" })).status,
      ).toBe(403);
      // Re-enabling without thinking_max keeps it; off turns thinking off for the team.
      const kept = await as.alice.put("/v1/team/models/deep", { enabled: true, is_default: false });
      expect(deep(kept)).toMatchObject({ thinking_max: "low" });
      const off = await as.alice.put("/v1/team/models/deep", {
        enabled: true,
        thinking_max: "off",
      });
      expect(deep(off)).toMatchObject({ thinking_in_team: { default: "off", levels: [] } });
      expect((await audit("models.team")).at(-1)?.target).toMatchObject({
        alias: "deep",
        thinkingMax: "off",
      });
      // Another team keeps the site's settings.
      expect(deep(await as.dave.get("/v1/team/models"))).toMatchObject({
        thinking_max: null,
        thinking_in_team: { default: "medium", levels: ["off", "low", "medium"] },
      });
      // When the site lowers its maximum later, the team's stays a ceiling, never a raise.
      await as.siteAdmin.patch(`${MODELS}/catalog/deep`, {
        thinking: { control: "reasoning_effort", allowed: true, default: "low", max: "low" },
      });
      const cleared = await as.alice.put("/v1/team/models/deep", {
        enabled: true,
        thinking_max: null,
      });
      expect(deep(cleared)).toMatchObject({
        thinking_max: null,
        thinking_in_team: { default: "low", levels: ["off", "low"] },
      });
      expect(
        (await as.alice.put("/v1/team/models/deep", { enabled: true, thinking_max: "max" })).status,
      ).toBe(400);
    } finally {
      expect((await as.siteAdmin.delete(`${MODELS}/catalog/deep`)).status).toBe(204);
    }
  });

  it("members see the catalog; only team admins enable models and pick the default", async () => {
    const seen = await as.bob.get("/v1/team/models");
    expect(seen.status).toBe(200);
    expect((seen.json.models as { enabled: boolean }[]).every((m) => !m.enabled)).toBe(true);
    expect((await as.bob.put("/v1/team/models/smart", { enabled: true })).status).toBe(403);

    expect((await as.alice.put("/v1/team/models/smart", { enabled: true })).status).toBe(200);
    const r = await as.alice.put("/v1/team/models/fast", { enabled: true, is_default: true });
    expect(r.status).toBe(200);
    expect(r.json.default).toBe("fast");
    const moved = await as.alice.put("/v1/team/models/smart", { enabled: true, is_default: true });
    expect(moved.json.default).toBe("smart");
    expect((await as.alice.put("/v1/team/models/nope", { enabled: true })).status).toBe(404);
    expect(
      (await as.alice.put("/v1/team/models/local", { enabled: false, is_default: true })).status,
    ).toBe(400);
    // Marketing enabled nothing: its view is its own.
    const other = await as.dave.get("/v1/team/models");
    expect(other.json.default).toBeNull();
    const events = await audit("models.team");
    expect(events.every((e) => e.team_id === finance)).toBe(true);
    expect(events.at(-1)?.target).toEqual({
      alias: "smart",
      enabled: true,
      isDefault: true,
      thinkingMax: null,
    });
  });
});

describe("gateway sync", () => {
  it("pushes providers, keys, the hierarchy and each member's allowed models; stores keys sealed", async () => {
    const bifrost = new FakeBifrost();
    const sync = newSync(bifrost);
    const result = await sync.runOnce();
    expect(result.errors).toEqual([]);
    expect([...bifrost.providers.keys()].sort()).toEqual([
      "anthropic",
      "gemini",
      "kobe-vllm",
      "ollama",
      "openai",
    ]);
    expect(bifrost.keyValue("openai")).toBe("sk-openai-0002");
    expect(bifrost.keyValue("anthropic")).toBe("sk-ant-secret-0001");
    expect([...bifrost.teams.values()].map((t) => t.name).sort()).toEqual(
      [gatewayTeamName(finance), gatewayTeamName(marketing)].sort(),
    );
    const vks = new Map([...bifrost.virtualKeys.values()].map((v) => [v.name, v]));
    expect(vks.get(virtualKeyName(finance, ids.bob))?.models).toEqual({
      anthropic: ["claude-sonnet-4-5"],
      openai: ["gpt-5-mini"],
    });
    expect(vks.get(virtualKeyName(marketing, ids.dave))?.models).toEqual({});

    const rows = await withTeam(h.deps.database.db, finance, (tx) =>
      tx.select().from(modelGatewayKeys),
    );
    expect(rows.map((r) => r.userId).sort()).toEqual([ids.alice, ids.bob].sort());
    for (const row of rows) {
      const vk = vks.get(virtualKeyName(finance, row.userId));
      expect(row.vkValueEnc).not.toContain("sk-bf-");
      expect(vkBox.open(row.vkValueEnc, virtualKeyContext(finance, row.userId))).toBe(vk?.value);
    }
    const status = await as.siteAdmin.get(MODELS);
    expect(status.json.gateway).toMatchObject({ in_sync: true, last_error: null });
  });

  it("propagates an admin change through LISTEN/NOTIFY within 10 s (leader only)", async () => {
    const bifrost = new FakeBifrost();
    const leader = newSync(bifrost);
    const follower = newSync(bifrost);
    leader.start();
    await until(() => leader.isLeader, Boolean);
    follower.start();
    await until(
      () => bifrost.virtualKeys.size,
      (n) => n >= 3,
    );
    expect(follower.isLeader).toBe(false);

    const started = Date.now();
    const r = await as.alice.put("/v1/team/models/local", { enabled: true });
    expect(r.status).toBe(200);
    const name = virtualKeyName(finance, ids.bob);
    const models = await until(
      () => [...bifrost.virtualKeys.values()].find((v) => v.name === name)?.models,
      (m) => m?.ollama?.[0] === "llama3.3",
    );
    expect(models?.ollama).toEqual(["llama3.3"]);
    expect(Date.now() - started).toBeLessThan(10_000);
    const status = await until(
      () => as.siteAdmin.get(MODELS),
      (s) => s.json.gateway.in_sync === true,
    );
    expect(status.json.gateway.in_sync).toBe(true);

    // The leader goes away: the follower takes over and keeps syncing.
    await leader.close();
    await until(() => follower.isLeader, Boolean);
    expect(follower.isLeader).toBe(true);
    await as.alice.put("/v1/team/models/local", { enabled: false });
    const after = await until(
      () => [...bifrost.virtualKeys.values()].find((v) => v.name === name)?.models,
      (m) => m !== undefined && !("ollama" in m),
    );
    expect(after).not.toHaveProperty("ollama");
    await follower.close();
  });

  it("removes a former member's and a deactivated user's keys, with a keys hint", async () => {
    const listener = new pg.Client({ connectionString: h.appUrl });
    await listener.connect();
    const hints: string[] = [];
    listener.on("notification", (n) => n.payload && hints.push(n.payload));
    await listener.query(`LISTEN ${MODELS_CHANNEL}`);
    try {
      const bifrost = new FakeBifrost();
      const sync = newSync(bifrost);
      await sync.runOnce();
      const db = h.deps.database.db;
      await asUser(ids.alice, () => removeMember(db, finance, ids.bob));
      await asUser(ids.owner, () => deactivateUser(db, ids.dave));
      const result = await sync.runOnce();
      expect(result.errors).toEqual([]);
      const names = [...bifrost.virtualKeys.values()].map((v) => v.name);
      expect(names).not.toContain(virtualKeyName(finance, ids.bob));
      expect(names).not.toContain(virtualKeyName(marketing, ids.dave));
      const rows = await withTeam(db, finance, (tx) => tx.select().from(modelGatewayKeys));
      expect(rows.map((r) => r.userId)).toEqual([ids.alice]);
      await until(
        () => hints,
        (x) => x.includes(`keys:${finance}`),
      );
      expect(hints).toContain(`keys:${finance}`);
    } finally {
      await listener.end();
    }
  });

  it("records an unreachable Bifrost as the last error and recovers on the next pass", async () => {
    const bifrost = new FakeBifrost();
    bifrost.down = true;
    const sync = newSync(bifrost);
    await as.siteAdmin.patch(`${MODELS}/providers/gemini`, { name: "Google Gemini" });
    expect((await sync.runOnce()).ok).toBe(false);
    const down = await as.siteAdmin.get(MODELS);
    expect(down.json.gateway).toMatchObject({ in_sync: false, last_error: "bifrost_unreachable" });
    bifrost.down = false;
    expect((await sync.runOnce()).ok).toBe(true);
    const up = await as.siteAdmin.get(MODELS);
    expect(up.json.gateway).toMatchObject({ in_sync: true, last_error: null });
  });

  // Last: re-seals everything with new secrets (earlier tests use the old boxes).
  it("rotates: a sync with new secrets (old ones previous) re-seals provider and virtual keys", async () => {
    const NEW_P = "q".repeat(40);
    const NEW_V = "w".repeat(40);
    const newProviders = new SecretBox([NEW_P, PROVIDER_SECRET], PROVIDER_KEY_PURPOSE);
    const newVks = new SecretBox([NEW_V, VK_SECRET], VIRTUAL_KEY_PURPOSE);
    const bifrost = new FakeBifrost();
    const sync = new ModelGatewaySync({
      db: h.deps.database.db,
      connectionString: h.appUrl,
      admin: bifrost,
      providerKeys: newProviders,
      virtualKeys: newVks,
      fingerprintSecret: PROVIDER_SECRET,
      logger,
      intervalMs: 3_600_000,
    });
    const result = await sync.runOnce();
    expect(result.errors).toEqual([]);
    expect(bifrost.keyValue("anthropic")).toBe("sk-ant-secret-0001");
    const { rows } = await h.admin.query<{ api_key_enc: string }>(
      "SELECT api_key_enc FROM model_providers WHERE api_key_enc IS NOT NULL",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => newProviders.isCurrent(r.api_key_enc))).toBe(true);
    const keys = await withTeam(h.deps.database.db, finance, (tx) =>
      tx.select().from(modelGatewayKeys),
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => newVks.isCurrent(k.vkValueEnc))).toBe(true);
  });
});
