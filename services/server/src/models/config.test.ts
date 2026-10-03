import { describe, expect, it } from "vitest";
import { loadModelsConfig } from "./config.js";

const full = {
  KOBE_BIFROST_URL: "http://kobe-bifrost:8080",
  KOBE_BIFROST_ADMIN_PASSWORD: "p".repeat(40),
  KOBE_MODELS_PROVIDER_KEY_SECRET: "a".repeat(40),
  KOBE_MODELS_VIRTUAL_KEY_SECRET: "b".repeat(40),
};

describe("loadModelsConfig", () => {
  it("is off when nothing is set", () => {
    expect(loadModelsConfig({})).toBeUndefined();
  });

  it("reads a complete configuration with defaults", () => {
    expect(loadModelsConfig(full)).toEqual({
      bifrostUrl: "http://kobe-bifrost:8080",
      adminUsername: "kobe",
      adminPassword: "p".repeat(40),
      providerKeySecrets: ["a".repeat(40)],
      virtualKeySecrets: ["b".repeat(40)],
      allowUnsafeEndpoints: false,
      syncIntervalMs: 30_000,
    });
  });

  it("fails fast on a partial or weak configuration without echoing secrets", () => {
    expect(() => loadModelsConfig({ KOBE_BIFROST_URL: full.KOBE_BIFROST_URL })).toThrow(
      /KOBE_BIFROST_ADMIN_PASSWORD/,
    );
    const weak = { ...full, KOBE_MODELS_VIRTUAL_KEY_SECRET: "short-secret-value" };
    expect(() => loadModelsConfig(weak)).toThrow(/at least 32/);
    expect(() => loadModelsConfig(weak)).not.toThrow(/short-secret-value/);
  });

  it("takes previous secrets for rotation and the operator's unsafe-endpoints switch", () => {
    const c = loadModelsConfig({
      ...full,
      KOBE_MODELS_PROVIDER_KEY_SECRET_PREVIOUS: "c".repeat(40),
      KOBE_MODELS_ALLOW_UNSAFE_ENDPOINTS: "true",
    });
    expect(c?.providerKeySecrets).toEqual(["a".repeat(40), "c".repeat(40)]);
    expect(c?.allowUnsafeEndpoints).toBe(true);
    expect(() =>
      loadModelsConfig({ ...full, KOBE_MODELS_VIRTUAL_KEY_SECRET_PREVIOUS: "short" }),
    ).toThrow(/PREVIOUS must be at least 32/);
  });

  it("refuses one secret for both purposes", () => {
    expect(() =>
      loadModelsConfig({ ...full, KOBE_MODELS_VIRTUAL_KEY_SECRET: "a".repeat(40) }),
    ).toThrow(/must differ/);
  });
});
