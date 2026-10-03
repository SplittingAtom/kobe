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
import { FakeBifrost } from "./models/testing/fake-bifrost.js";
import { createTeamWithAdmin, removeMember } from "./teams/members.js";
import { deactivateUser } from "./users/deactivation.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-40: install model admin (providers with write-only keys, catalog), team enablement, audit,
 * and the gateway sync (Bifrost faked in memory; the real one is exercised by e2e and the
 * `bifrost.int.test.ts` check against a local binary).
 */
const PROVIDER_SECRET = "p".repeat(40);
const VK_SECRET = "v".repeat(40);
const providerBox = new SecretBox(PROVIDER_SECRET, PROVIDER_KEY_PURPOSE);
const vkBox = new SecretBox(VK_SECRET, VIRTUAL_KEY_PURPOSE);
const logger = pino({ level: "silent" });

let h: Harness;
const ids = { owner: "", installAdmin: "", alice: "", bob: "", dave: "" };
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
  h = await openHarness({ models: { providerKeySecret: PROVIDER_SECRET } });
  ids.owner = await h.createUser("owner@models.test", "owner");
  ids.installAdmin = await h.createUser("admin@models.test", "admin");
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
    installAdmin: await h.signIn("admin@models.test"),
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

const MODELS = "/v1/install/models";

describe("install providers", () => {
  it("is for install admins only", async () => {
    expect((await as.alice.get(MODELS)).status).toBe(403);
    expect(
      (await as.alice.post(`${MODELS}/providers`, { kind: "openai", name: "x", api_key: "k" }))
        .status,
    ).toBe(403);
  });

  it("stores the API key sealed, never returns or audits it", async () => {
    const res = await as.installAdmin.post(`${MODELS}/providers`, {
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
    expect(providerBox.open(rows[0]?.api_key_enc ?? "", providerKeyContext("anthropic"))).toBe(
      "sk-ant-secret-0001",
    );
    const listed = await as.installAdmin.get(MODELS);
    expect(JSON.stringify(listed.json)).not.toContain("sk-ant-secret");
    const events = await audit("models.provider");
    expect(events.at(-1)).toMatchObject({
      action: "models.provider.added",
      team_id: null,
      target: { providerId: "anthropic", kind: "anthropic", keySet: true, privateNetwork: false },
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
      const r = await as.installAdmin.post(`${MODELS}/providers`, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(JSON.stringify(r.json)).not.toContain("has space");
    }
    const dup = await as.installAdmin.post(`${MODELS}/providers`, {
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
      const r = await as.installAdmin.post(`${MODELS}/providers`, body);
      expect(r.status, JSON.stringify(r.json)).toBe(201);
    }
    const ollama = await as.installAdmin.get(MODELS);
    const byId = Object.fromEntries(
      (ollama.json.providers as { id: string }[]).map((p) => [p.id, p]),
    );
    expect(byId.ollama).toMatchObject({ base_url: "http://ollama.lan:11434", key_set: false });
    expect(byId.vllm).toMatchObject({ gateway_provider: "kobe-vllm", key_set: false });

    const r = await as.installAdmin.patch(`${MODELS}/providers/openai`, {
      api_key: "sk-openai-0002",
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.provider).toMatchObject({ key_set: true, key_revision: 2 });
    expect((await audit("models.provider.changed")).at(-1)?.target).toMatchObject({
      providerId: "openai",
      keyChanged: true,
      baseUrlChanged: false,
    });
    expect(
      (await as.installAdmin.patch(`${MODELS}/providers/openai`, { api_key: null })).status,
    ).toBe(400);
    expect((await as.installAdmin.patch(`${MODELS}/providers/nope`, { name: "x" })).status).toBe(
      404,
    );
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
      const r = await as.installAdmin.post(`${MODELS}/catalog`, body);
      expect(r.status, JSON.stringify(r.json)).toBe(201);
    }
    const list = await as.installAdmin.get(MODELS);
    const qwen = (list.json.catalog as { alias: string; gateway_model: string }[]).find(
      (c) => c.alias === "qwen",
    );
    expect(qwen?.gateway_model).toBe("kobe-vllm/qwen/qwen3-8b");
    expect(
      (
        await as.installAdmin.post(`${MODELS}/catalog`, {
          alias: "x",
          provider_id: "nope",
          model: "m",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await as.installAdmin.post(`${MODELS}/catalog`, {
          alias: "smart",
          provider_id: "openai",
          model: "m",
        })
      ).status,
    ).toBe(409);
    expect((await as.installAdmin.delete(`${MODELS}/providers/vllm`)).status).toBe(409);
    expect((await audit("models.catalog")).map((e) => e.target.change)).toEqual([
      "added",
      "added",
      "added",
      "added",
    ]);
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
    expect(events.at(-1)?.target).toEqual({ alias: "smart", enabled: true, isDefault: true });
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
    const status = await as.installAdmin.get(MODELS);
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
      () => as.installAdmin.get(MODELS),
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
    await as.installAdmin.patch(`${MODELS}/providers/gemini`, { name: "Google Gemini" });
    expect((await sync.runOnce()).ok).toBe(false);
    const down = await as.installAdmin.get(MODELS);
    expect(down.json.gateway).toMatchObject({ in_sync: false, last_error: "bifrost_unreachable" });
    bifrost.down = false;
    expect((await sync.runOnce()).ok).toBe(true);
    const up = await as.installAdmin.get(MODELS);
    expect(up.json.gateway).toMatchObject({ in_sync: true, last_error: null });
  });
});
