import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("sandbox-agent loadConfig", () => {
  it("requires a wss:// server URL", () => {
    expect(
      loadConfig({ KOBE_SERVER_URL: "wss://kobe-server.kobe-system.svc/sandbox" }).serverUrl,
    ).toBe("wss://kobe-server.kobe-system.svc/sandbox");
  });

  it("allows ws:// only for in-cluster plaintext during development", () => {
    expect(loadConfig({ KOBE_SERVER_URL: "ws://kobe-server:8080/sandbox" }).serverUrl).toBe(
      "ws://kobe-server:8080/sandbox",
    );
  });

  it("rejects a missing or non-WebSocket server URL", () => {
    expect(() => loadConfig({})).toThrow(/KOBE_SERVER_URL/);
    expect(() => loadConfig({ KOBE_SERVER_URL: "https://kobe" })).toThrow(/KOBE_SERVER_URL/);
  });
});
