import { describe, expect, it } from "vitest";
import { orbitModelId, resolveOrbitModel, type OrbitModelOption } from "./model.js";

const option = (over: Partial<OrbitModelOption>): OrbitModelOption => ({
  alias: "smart",
  isDefault: false,
  kind: "anthropic",
  providerId: "anthropic",
  model: "claude-x",
  ...over,
});

describe("orbitModelId (KOBE-91)", () => {
  it("names vendor models <kind>/<model>", () => {
    expect(orbitModelId(option({}))).toBe("anthropic/claude-x");
    expect(orbitModelId(option({ kind: "ollama", model: "llama3:8b" }))).toBe("ollama/llama3:8b");
  });

  it("names OpenAI-compatible endpoints openai-api/<provider>/<model>", () => {
    expect(
      orbitModelId(option({ kind: "openai_compatible", providerId: "vllm", model: "m" })),
    ).toBe("openai-api/vllm/m");
  });
});

describe("resolveOrbitModel", () => {
  const options = [
    option({ alias: "smart" }),
    option({ alias: "fast", isDefault: true, model: "f" }),
  ];

  it("resolves the pinned alias", () => {
    expect(resolveOrbitModel("smart", options)).toEqual({ ok: true, model: "anthropic/claude-x" });
  });

  it("falls back to the team default when nothing is pinned", () => {
    expect(resolveOrbitModel(undefined, options)).toEqual({ ok: true, model: "anthropic/f" });
  });

  it("fails, never drops, when the pinned alias is not enabled for the team", () => {
    expect(resolveOrbitModel("local", options)).toMatchObject({
      ok: false,
      code: "model_not_resolvable",
    });
  });

  it("fails when nothing is pinned and the team has no default", () => {
    expect(resolveOrbitModel(undefined, [option({})])).toMatchObject({ ok: false });
  });
});
