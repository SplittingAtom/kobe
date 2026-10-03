import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const env = {
  KOBE_DATABASE_URL: "postgres://app@db/kobe",
  KOBE_SESSION_KEY_MODEL_GATEWAY: "m".repeat(40),
  KOBE_MODELS_VIRTUAL_KEY_SECRET: "v".repeat(40),
  KOBE_BIFROST_URL: "http://kobe-bifrost:8080/",
};

describe("loadConfig", () => {
  it("reads the chart's env with defaults", () => {
    expect(loadConfig(env)).toMatchObject({
      port: 8080,
      bifrostUrl: "http://kobe-bifrost:8080",
      maxBodyBytes: 32 * 1024 * 1024,
      maxCallsPerSandbox: 16,
      cacheTtlMs: 5_000,
    });
  });

  it("fails fast on a missing or weak key without echoing it", () => {
    expect(() => loadConfig({ ...env, KOBE_SESSION_KEY_MODEL_GATEWAY: undefined })).toThrow(
      /KOBE_SESSION_KEY_MODEL_GATEWAY is required/,
    );
    const weak = { ...env, KOBE_MODELS_VIRTUAL_KEY_SECRET: "weak-secret-value" };
    expect(() => loadConfig(weak)).toThrow(/at least 32/);
    expect(() => loadConfig(weak)).not.toThrow(/weak-secret-value/);
    expect(() => loadConfig({ ...env, KOBE_BIFROST_URL: "ftp://x" })).toThrow(/KOBE_BIFROST_URL/);
  });
});
