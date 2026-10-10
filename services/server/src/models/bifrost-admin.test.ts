import { describe, expect, it } from "vitest";
import { BifrostAdminError, createHttpBifrostAdmin } from "./bifrost-admin.js";

/** KOBE-44: the model listing calls of the Bifrost admin client (Bifrost v2.2 `/api/*`). */
function stub(replies: Record<string, [number, unknown]>) {
  const seen: { method: string; url: string; auth: string | null }[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    seen.push({ method, url, auth: new Headers(init.headers).get("authorization") });
    const path = url.replace("http://bifrost:8080", "");
    const [status, body] = replies[`${method} ${path}`] ?? [404, {}];
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  const admin = createHttpBifrostAdmin({
    baseUrl: "http://bifrost:8080/",
    username: "kobe",
    password: "x".repeat(32),
    fetch: fetchFn,
  });
  return { admin, seen };
}

describe("Bifrost admin model listing", () => {
  it("lists a provider's models with the admin credential, names only", async () => {
    const { admin, seen } = stub({
      "GET /api/models?provider=kobe-vllm&limit=1000": [
        200,
        { models: [{ name: "qwen3", provider: "kobe-vllm" }, { provider: "x" }, "junk"], total: 3 },
      ],
    });
    expect(await admin.listModels("kobe-vllm")).toEqual(["qwen3"]);
    expect(seen[0]?.auth).toMatch(/^Bearer /);
  });

  it("reads the input modalities a model reports, top level or under architecture", async () => {
    const { admin } = stub({
      "GET /api/models?provider=p&limit=1000": [
        200,
        {
          models: [
            { name: "a", input_modalities: ["text", "IMAGE"] },
            { name: "b", architecture: { input_modalities: ["text"] } },
            { name: "c" },
            { name: "d", input_modalities: "image" },
          ],
        },
      ],
    });
    expect(await admin.listModelInfo("p")).toEqual([
      { name: "a", inputModalities: ["text", "image"] },
      { name: "b", inputModalities: ["text"] },
      { name: "c", inputModalities: [] },
      { name: "d", inputModalities: [] },
    ]);
  });

  it("refreshes through the provider's refresh-models route; errors carry the status only", async () => {
    const { admin, seen } = stub({
      "POST /api/providers/ollama/refresh-models": [200, { keys: [], total: 0 }],
      "POST /api/providers/openai/refresh-models": [409, { error: "in progress" }],
    });
    await admin.refreshModels("ollama");
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "POST http://bifrost:8080/api/providers/ollama/refresh-models",
    ]);
    const failure = await admin.refreshModels("openai").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(BifrostAdminError);
    expect((failure as BifrostAdminError).status).toBe(409);
    expect((failure as Error).message).not.toContain("in progress");
  });

  it("reads each key's discovery status and description, never its value", async () => {
    const { admin } = stub({
      "GET /api/providers/ollama/keys": [
        200,
        {
          keys: [
            {
              id: "k1",
              name: "kobe-ollama-ab",
              value: "sk-****",
              status: "list_models_failed",
              description: "401",
            },
          ],
        },
      ],
    });
    expect(await admin.listKeys("ollama")).toEqual([
      { id: "k1", name: "kobe-ollama-ab", status: "list_models_failed", description: "401" },
    ]);
  });
});
