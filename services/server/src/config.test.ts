import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const REQUIRED = {
  KOBE_DATABASE_URL: "postgres://kobe_app:pw@db:5432/kobe",
  KOBE_PUBLIC_URL: "https://kobe.example.com",
  KOBE_AUTH_SECRET: "x".repeat(32),
  KOBE_SETUP_TOKEN: "t".repeat(24),
};

describe("loadConfig", () => {
  it("defaults the port to 8080 and the process to the API server", () => {
    expect(loadConfig(REQUIRED)).toMatchObject({ port: 8080, process: "server" });
  });

  it("reads PORT and KOBE_PROCESS", () => {
    expect(loadConfig({ ...REQUIRED, PORT: "9090", KOBE_PROCESS: "scheduler" })).toMatchObject({
      port: 9090,
      process: "scheduler",
    });
  });

  it("rejects an invalid port or process role with a clear error", () => {
    expect(() => loadConfig({ ...REQUIRED, PORT: "70000" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...REQUIRED, KOBE_PROCESS: "worker" })).toThrow(/KOBE_PROCESS/);
  });

  it("requires a postgres database URL", () => {
    const { KOBE_DATABASE_URL: _, ...rest } = REQUIRED;
    expect(() => loadConfig(rest)).toThrow(/KOBE_DATABASE_URL/);
    expect(() => loadConfig({ ...REQUIRED, KOBE_DATABASE_URL: "mysql://x" })).toThrow(
      /KOBE_DATABASE_URL/,
    );
  });

  it("requires an http(s) public URL without a path", () => {
    expect(loadConfig(REQUIRED).auth?.publicUrl).toBe("https://kobe.example.com");
    expect(() => loadConfig({ ...REQUIRED, KOBE_PUBLIC_URL: "kobe.example.com" })).toThrow(
      /KOBE_PUBLIC_URL/,
    );
    expect(() =>
      loadConfig({ ...REQUIRED, KOBE_PUBLIC_URL: "https://kobe.example.com/app" }),
    ).toThrow(/KOBE_PUBLIC_URL/);
  });

  it("requires an auth secret of at least 32 characters", () => {
    expect(() => loadConfig({ ...REQUIRED, KOBE_AUTH_SECRET: "short" })).toThrow(
      /KOBE_AUTH_SECRET/,
    );
  });

  it("requires a setup token of at least 24 characters", () => {
    expect(() => loadConfig({ ...REQUIRED, KOBE_SETUP_TOKEN: "short" })).toThrow(
      /KOBE_SETUP_TOKEN/,
    );
  });

  it("parses trusted proxy CIDRs", () => {
    expect(loadConfig(REQUIRED).auth?.trustedProxies).toEqual([]);
    expect(
      loadConfig({ ...REQUIRED, KOBE_TRUSTED_PROXIES: "10.42.0.0/16, 10.43.0.0/16" }).auth
        ?.trustedProxies,
    ).toEqual(["10.42.0.0/16", "10.43.0.0/16"]);
    expect(() => loadConfig({ ...REQUIRED, KOBE_TRUSTED_PROXIES: "not-a-cidr" })).toThrow(
      /KOBE_TRUSTED_PROXIES/,
    );
  });

  it("does not give the scheduler auth secrets (least privilege)", () => {
    const scheduler = loadConfig({
      KOBE_PROCESS: "scheduler",
      KOBE_DATABASE_URL: REQUIRED.KOBE_DATABASE_URL,
    });
    expect(scheduler.auth).toBeUndefined();
    expect(loadConfig(REQUIRED).auth).toMatchObject({ setupToken: "t".repeat(24) });
  });

  it("never echoes secret values in errors", () => {
    expect(() => loadConfig({ ...REQUIRED, KOBE_AUTH_SECRET: "hunter2" })).not.toThrow(/hunter2/);
  });
});
