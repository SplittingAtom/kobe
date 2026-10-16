import { describe, expect, it } from "vitest";
import {
  GATEWAY_MODEL_MAX_LENGTH,
  GATEWAY_MODEL_PATTERN,
  gatewayModelSchema,
  piThreadConfigSchema,
} from "../index.js";

/**
 * KOBE-280: one gateway-model limit. The wire schema and the kobe-models model file (which keeps
 * a pinned copy of {@link GATEWAY_MODEL_PATTERN}) accept exactly the same ids: a provider of at most
 * 64 characters and a model of at most 191, so Pi is never started with a `--model` its model
 * file then refuses.
 */
const ok = (id: string) => gatewayModelSchema.safeParse(id).success;

describe("gateway model limit (KOBE-280)", () => {
  it("allows a model part of 191 characters and refuses 192, whatever the total", () => {
    expect(ok(`p/${"m".repeat(191)}`)).toBe(true);
    expect(ok(`p/${"m".repeat(192)}`)).toBe(false);
    expect(ok(`${"p".repeat(64)}/${"m".repeat(191)}`)).toBe(true);
    expect(ok(`${"p".repeat(65)}/m`)).toBe(false);
  });

  it("is the pattern the schema checks, and bounds the total", () => {
    expect(GATEWAY_MODEL_MAX_LENGTH).toBe(256);
    const longest = `${"p".repeat(64)}/${"m".repeat(191)}`;
    expect(longest).toHaveLength(GATEWAY_MODEL_MAX_LENGTH);
    expect(GATEWAY_MODEL_PATTERN.test(longest)).toBe(true);
    for (const id of ["kobe-vllm/qwen3", "gemini/gemini-2.5-pro", "x/y:z", "-x/y", "x/", "x"]) {
      expect(ok(id)).toBe(GATEWAY_MODEL_PATTERN.test(id));
    }
  });

  it("run.start's model uses it", () => {
    const config = (gateway_model: string) =>
      piThreadConfigSchema.safeParse({ model: { alias: "a", gateway_model } }).success;
    expect(config(`p/${"m".repeat(191)}`)).toBe(true);
    expect(config(`p/${"m".repeat(192)}`)).toBe(false);
  });
});
