import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("defaults the port to 8080", () => {
    expect(loadConfig({}).port).toBe(8080);
  });

  it("reads PORT from the environment", () => {
    expect(loadConfig({ PORT: "9090" }).port).toBe(9090);
  });

  it("rejects an invalid port with a clear error", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: "70000" })).toThrow(/PORT/);
  });
});

describe("loadConfig process role", () => {
  it("defaults to the API server", () => {
    expect(loadConfig({}).process).toBe("server");
  });

  it("accepts the scheduler role", () => {
    expect(loadConfig({ KOBE_PROCESS: "scheduler" }).process).toBe("scheduler");
  });

  it("rejects unknown roles", () => {
    expect(() => loadConfig({ KOBE_PROCESS: "worker" })).toThrow(/KOBE_PROCESS/);
  });
});
