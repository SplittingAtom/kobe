import { afterEach, describe, expect, it, vi } from "vitest";
import * as install from "./install/models";
import * as team from "./team/models";

/** KOBE-44: the model admin resources send each route's wire casing and unwrap its envelope. */
type Call = { url: string; method: string; team: string | null; body: unknown };

function stubApi(reply: unknown, status = 200) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        team: new Headers(init.headers).get("x-kobe-team"),
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(status === 204 ? null : JSON.stringify(reply), { status });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("install model resources", () => {
  it("sends only what changed and unwraps the provider", async () => {
    const calls = stubApi({ provider: { id: "openai", key_set: true } });
    const res = await install.updateProvider("openai", { apiKey: "sk-x", name: undefined });
    expect(res).toMatchObject({ ok: true, data: { id: "openai", keySet: true } });
    expect(calls).toEqual([
      {
        url: "/v1/install/models/providers/openai",
        method: "PATCH",
        team: null,
        body: { api_key: "sk-x" },
      },
    ]);
  });

  it("removes a key with null, re-points and clears a label, deletes", async () => {
    const calls = stubApi({ model: { alias: "fast" } });
    await install.updateProvider("ollama", { apiKey: null });
    await install.updateCatalogModel("fast", { providerId: "openai", model: "gpt-5", label: null });
    expect(calls.map((c) => c.body)).toEqual([
      { api_key: null },
      { provider_id: "openai", model: "gpt-5", label: null },
    ]);
    const del = stubApi(undefined, 204);
    expect((await install.deleteProvider("vllm")).ok).toBe(true);
    await install.deleteCatalogModel("a.b");
    expect(del.map((c) => `${c.method} ${c.url}`)).toEqual([
      "DELETE /v1/install/models/providers/vllm",
      "DELETE /v1/install/models/catalog/a.b",
    ]);
  });

  it("lists and refreshes a provider's models", async () => {
    const calls = stubApi({ provider_id: "ollama", models: ["glm-5.3"], discovery: "ok" });
    const listed = await install.listProviderModels("ollama");
    await install.refreshProviderModels("ollama");
    expect(listed).toMatchObject({ ok: true, data: { providerId: "ollama", models: ["glm-5.3"] } });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /v1/install/models/providers/ollama/models",
      "POST /v1/install/models/providers/ollama/models/refresh",
    ]);
  });
});

describe("team model resources", () => {
  it("reads and changes the team's models with the team header", async () => {
    const calls = stubApi({ models: [{ alias: "kimi", is_default: true }], default: "kimi" });
    const res = await team.listTeamModels("t-1");
    expect(res).toMatchObject({
      ok: true,
      data: { default: "kimi", models: [{ isDefault: true }] },
    });
    await team.setTeamModel("t-1", "kimi", { enabled: false });
    expect(calls.map((c) => [c.method, c.url, c.team, c.body])).toEqual([
      ["GET", "/v1/team/models", "t-1", undefined],
      ["PUT", "/v1/team/models/kimi", "t-1", { enabled: false }],
    ]);
    expect(team.modelName({ alias: "kimi", label: null })).toBe("kimi");
  });
});
