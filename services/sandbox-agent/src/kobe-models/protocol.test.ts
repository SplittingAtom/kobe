import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  GATEWAY_MODEL_PATTERN as PROTOCOL_GATEWAY_MODEL,
  KOBE_MODEL_ERROR_PREFIX as PROTOCOL_PREFIX,
  MODEL_LIMITS_MAX_TOKENS as PROTOCOL_MAX_TOKENS,
  MODEL_RUN_ERROR_CODES as PROTOCOL_CODES,
  PI_MODEL_APIS as PROTOCOL_APIS,
  piThreadConfigSchema,
} from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_MODEL,
  KOBE_MODEL_ERROR_PREFIX,
  MODEL_LIMITS_MAX_TOKENS,
  MODEL_RUN_ERROR_CODES,
  PI_MODEL_APIS,
  gatewayBaseUrl,
  parseModelFile,
} from "./protocol.js";

const RUN = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6072";
const valid = {
  v: 1,
  gateway_url: "http://model-gateway.kobe.internal:80",
  model: { gateway_model: "anthropic/claude-sonnet-4-5", api: "anthropic-messages" },
  token: "t".repeat(40),
  run_id: RUN,
};

const parses = (text: string): boolean => {
  try {
    parseModelFile(text);
    return true;
  } catch {
    return false;
  }
};

describe("kobe-models protocol", () => {
  it("pins its copies of the @kobe/protocol constants (the extension ships on its own)", () => {
    expect(KOBE_MODEL_ERROR_PREFIX).toBe(PROTOCOL_PREFIX);
    expect([...MODEL_RUN_ERROR_CODES]).toEqual([...PROTOCOL_CODES]);
    expect([...PI_MODEL_APIS]).toEqual([...PROTOCOL_APIS]);
    expect(MODEL_LIMITS_MAX_TOKENS).toBe(PROTOCOL_MAX_TOKENS);
    // One gateway-model limit (KOBE-280): the model file checks the contract's own pattern.
    expect(GATEWAY_MODEL.source).toBe(PROTOCOL_GATEWAY_MODEL.source);
    expect(GATEWAY_MODEL.flags).toBe(PROTOCOL_GATEWAY_MODEL.flags);
    // The wire and the model file agree on every id, up to the 191-character model part.
    const ids = [
      ["kobe-vllm/qwen3", true],
      ["gemini/gemini-2.5-pro", true],
      ["x/y:z", true],
      [`p/${"m".repeat(191)}`, true],
      [`p/${"m".repeat(192)}`, false],
    ] as const;
    for (const [gateway_model, accepted] of ids) {
      const file = JSON.stringify({ ...valid, model: { ...valid.model, gateway_model } });
      expect(parses(file)).toBe(accepted);
      expect(piThreadConfigSchema.safeParse({ model: { alias: "a", gateway_model } }).success).toBe(
        accepted,
      );
    }
  });

  it("parses the agent's model file and normalises the run id", () => {
    expect(parseModelFile(JSON.stringify({ ...valid, run_id: RUN.toUpperCase() }))).toEqual(valid);
    expect(parseModelFile(JSON.stringify({ ...valid, run_id: null })).run_id).toBeNull();
    expect(parseModelFile(JSON.stringify({ ...valid, model: null })).model).toBeNull();
  });

  it("parses the model's output limit and context window when the agent wrote them (KOBE-259)", () => {
    const model = { ...valid.model, max_output_tokens: 32_768, context_window: 200_000 };
    expect(parseModelFile(JSON.stringify({ ...valid, model })).model).toEqual(model);
  });

  const withLimits = (limits: object) =>
    JSON.stringify({ ...valid, model: { ...valid.model, ...limits } });

  it.each([
    ["not JSON", "{"],
    ["an output limit without a context window", withLimits({ max_output_tokens: 1_000 })],
    ["a zero output limit", withLimits({ max_output_tokens: 0, context_window: 8_192 })],
    ["a fractional output limit", withLimits({ max_output_tokens: 1.5, context_window: 8_192 })],
    [
      "a window above the bound",
      withLimits({ max_output_tokens: 1_000, context_window: MODEL_LIMITS_MAX_TOKENS + 1 }),
    ],
    [
      "an output limit that fills the window",
      withLimits({ max_output_tokens: 8_192, context_window: 8_192 }),
    ],
    ["another version", JSON.stringify({ ...valid, v: 2 })],
    ["a gateway URL with a path", JSON.stringify({ ...valid, gateway_url: "http://gw/v1" })],
    ["a gateway URL with credentials", JSON.stringify({ ...valid, gateway_url: "http://u:p@gw" })],
    [
      "a model without its gateway provider",
      JSON.stringify({ ...valid, model: { ...valid.model, gateway_model: "claude" } }),
    ],
    [
      "an unknown API style",
      JSON.stringify({ ...valid, model: { ...valid.model, api: "custom" } }),
    ],
    ["a short token", JSON.stringify({ ...valid, token: "short" })],
    ["a run id that is not a uuid", JSON.stringify({ ...valid, run_id: "run-1" })],
  ])("refuses %s", (_name, text) => {
    expect(() => parseModelFile(text)).toThrow();
  });

  it("builds the gateway base URL per API style (KOBE-40 paths)", () => {
    const gw = "http://model-gateway.kobe.internal:80";
    expect(gatewayBaseUrl(gw, "openai-completions")).toBe(`${gw}/v1`);
    expect(gatewayBaseUrl(gw, "anthropic-messages")).toBe(`${gw}/anthropic`);
    expect(gatewayBaseUrl(gw, "google-generative-ai")).toBe(`${gw}/genai/v1beta`);
    expect(gatewayBaseUrl(`${gw}/`, "openai-completions")).toBe(`${gw}/v1`);
  });

  it("imports only node builtins, pi-ai and files in its own directory (it ships on its own)", async () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const sources = (await readdir(dir)).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    expect(sources).toContain("index.ts");
    for (const file of sources) {
      const text = await readFile(new URL(file, import.meta.url), "utf8");
      const specifiers = [...text.matchAll(/\bfrom\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/g)].map(
        (m) => m[1] ?? m[2],
      );
      for (const specifier of specifiers) {
        expect(
          specifier?.startsWith("node:") ||
            specifier === "@earendil-works/pi-ai" ||
            /^\.\/[\w-]+\.js$/.test(specifier ?? ""),
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });
});
