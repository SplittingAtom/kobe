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
