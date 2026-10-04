import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROVIDER_KEY_PURPOSE, SecretBox, VIRTUAL_KEY_PURPOSE } from "@kobe/db";
import { catalogModelIds, scrubDetail } from "./models/discovery.js";
import { ModelGatewaySync } from "./models/sync.js";
import { FakeBifrost } from "./models/testing/fake-bifrost.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-44: the catalog editor's model picker. Install admins list a provider's models through
 * the gateway (Bifrost holds the key and reaches the provider); a refresh, which makes Bifrost
 * call the provider with the key, is audited and rate-limited. No key is ever returned.
 */
const PROVIDER_SECRET = "p".repeat(40);
const KEY = "sk-ollama-cloud-secret-key-0123456789";
const bifrost = new FakeBifrost();

let h: Harness;
let owner: TestBrowser;
let member: TestBrowser;

const sync = () =>
  new ModelGatewaySync({
    db: h.deps.database.db,
    connectionString: h.appUrl,
    admin: bifrost,
    providerKeys: new SecretBox(PROVIDER_SECRET, PROVIDER_KEY_PURPOSE),
    virtualKeys: new SecretBox("v".repeat(40), VIRTUAL_KEY_PURPOSE),
    fingerprintSecret: PROVIDER_SECRET,
    logger: pino({ level: "silent" }),
    intervalMs: 3_600_000,
  }).runOnce();

beforeAll(async () => {
  h = await openHarness({
    models: { providerKeySecrets: [PROVIDER_SECRET], discovery: bifrost },
  });
  await h.createUser("owner@discovery.test", "owner");
  await h.createUser("member@discovery.test");
  owner = await h.signIn("owner@discovery.test");
  member = await h.signIn("member@discovery.test");
  // The real test install: Ollama Cloud with an API key.
  const added = await owner.post("/v1/install/models/providers", {
    kind: "ollama",
    name: "Ollama Cloud",
    base_url: "https://ollama.com",
    api_key: KEY,
  });
  expect(added.status, JSON.stringify(added.json)).toBe(201);
}, 120_000);
afterAll(() => h.close());

const BASE = "/v1/install/models/providers/ollama/models";

async function refreshAudit() {
  const { rows } = await h.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE action = 'models.provider.models_refreshed' ORDER BY seq`,
  );
  return rows.map((r) => r.target);
}

describe("provider model listing", () => {
  it("is for install admins only", async () => {
    expect((await member.get(BASE)).status).toBe(403);
    expect((await member.post(`${BASE}/refresh`)).status).toBe(403);
  });

  it("says the gateway hasn't got the provider before the sync, then lists after a refresh", async () => {
    const before = await owner.get(BASE);
    expect(before.status).toBe(409);
    expect(before.json.code).toBe("provider_not_synced");

    await sync();
    bifrost.upstream.set("ollama", ["kimi-k2.7-code", "glm-5.3", "ollama/glm-5.3", "bad id!"]);
    const cached = await owner.get(BASE);
    expect(cached.json).toEqual({
      provider_id: "ollama",
      models: [],
      discovery: "unknown",
      detail: null,
      truncated: false,
    });
    expect(bifrost.calls).not.toContain("models.refresh ollama"); // a read never calls out

    const refreshed = await owner.post(`${BASE}/refresh`);
    expect(refreshed.status, JSON.stringify(refreshed.json)).toBe(200);
    expect(refreshed.json).toMatchObject({
      models: ["glm-5.3", "kimi-k2.7-code"], // prefix dropped, deduplicated, invalid ids skipped
      discovery: "ok",
    });
    expect(JSON.stringify(refreshed.json)).not.toContain(KEY);
    expect((await owner.get(BASE)).json.models).toEqual(["glm-5.3", "kimi-k2.7-code"]);
    expect(await refreshAudit()).toEqual([
      { providerId: "ollama", kind: "ollama", outcome: "ok", models: 2 },
    ]);
  });

  it("reports a refused key with the provider's reason, scrubbed of key material", async () => {
    bifrost.upstream.set("ollama", {
      error: `401 unauthorized: invalid api key ${KEY}\u0007 — check the key`,
    });
    const res = await owner.post(`${BASE}/refresh`);
    expect(res.status).toBe(200);
    expect(res.json.discovery).toBe("failed");
    expect(res.json.detail).toBe("401 unauthorized: invalid api key [redacted] — check the key");
    expect(JSON.stringify(res.json)).not.toContain(KEY);
    expect((await refreshAudit()).at(-1)).toEqual({
      providerId: "ollama",
      kind: "ollama",
      outcome: "failed",
      models: 2,
    });
    const events = await h.admin.query(`SELECT target::text AS t FROM audit_log`);
    expect(events.rows.map((r: { t: string }) => r.t).join()).not.toContain(KEY);
  });

  it("is rate-limited per provider and answers 503 when the gateway is down", async () => {
    let limited = 0;
    for (let i = 0; i < 8; i += 1) {
      if ((await owner.post(`${BASE}/refresh`)).status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
    bifrost.down = true;
    try {
      const res = await owner.get(BASE);
      expect(res.status).toBe(503);
      expect(res.json.code).toBe("gateway_unavailable");
    } finally {
      bifrost.down = false;
    }
    expect((await owner.get("/v1/install/models/providers/nope/models")).status).toBe(404);
    expect((await owner.get("/v1/install/models/providers/Bad_Id/models")).status).toBe(404);
  });
});

describe("helpers", () => {
  it("scrubs control characters and token-like strings, and bounds the text", () => {
    expect(scrubDetail(undefined)).toBeNull();
    expect(scrubDetail("  \u0000 ")).toBeNull();
    expect(scrubDetail("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx")).toBe("Bearer [redacted]");
    expect(scrubDetail("x".repeat(500))).toBe("[redacted]");
    expect(scrubDetail("word ".repeat(100))?.length).toBe(200);
  });

  it("caps the list and drops only its own provider's prefix", () => {
    expect(catalogModelIds(["kobe-vllm/qwen3", "other/x"], "kobe-vllm").models).toEqual([
      "other/x",
      "qwen3",
    ]);
    const many = Array.from({ length: 1200 }, (_, i) => `m${i}`);
    const capped = catalogModelIds(many, "openai");
    expect(capped.models).toHaveLength(1000);
    expect(capped.truncated).toBe(true);
  });
});
