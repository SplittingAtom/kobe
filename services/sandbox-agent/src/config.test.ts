import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const SANDBOX = "af1a2b3c-4d5e-4f60-9182-93a4b5c6d7e8";
const base = { KOBE_SANDBOX_ID: SANDBOX };

describe("sandbox-agent loadConfig", () => {
  it("requires a wss:// server URL and appends the contract path", () => {
    const config = loadConfig({ ...base, KOBE_SERVER_URL: "wss://kobe-server.kobe-system.svc" });
    expect(config.serverUrl).toBe("wss://kobe-server.kobe-system.svc");
    expect(config.connectUrl).toBe("wss://kobe-server.kobe-system.svc/v1/sandbox/connect");
  });

  it("replaces any path on the server URL with the contract path", () => {
    expect(
      loadConfig({ ...base, KOBE_SERVER_URL: "wss://kobe-server/sandbox?x=1" }).connectUrl,
    ).toBe("wss://kobe-server/v1/sandbox/connect");
  });

  it("allows ws:// only for in-cluster plaintext during development", () => {
    expect(loadConfig({ ...base, KOBE_SERVER_URL: "ws://kobe-server:8080" }).connectUrl).toBe(
      "ws://kobe-server:8080/v1/sandbox/connect",
    );
  });

  it("rejects a missing or non-WebSocket server URL", () => {
    expect(() => loadConfig({})).toThrow(/KOBE_SERVER_URL must be a ws/);
    expect(() => loadConfig({ ...base, KOBE_SERVER_URL: "https://kobe" })).toThrow(
      /KOBE_SERVER_URL/,
    );
  });

  it("rejects credentials in the server URL (the token goes in a header, never a URL)", () => {
    expect(() => loadConfig({ ...base, KOBE_SERVER_URL: "wss://u:p@kobe-server" })).toThrow(
      /KOBE_SERVER_URL/,
    );
  });

  it("in bootstrap mode (Kobe's pods) takes the sandbox id from the server instead", () => {
    const config = loadConfig({
      KOBE_SERVER_URL: "ws://server.kobe.internal:8081",
      KOBE_BOOTSTRAP_TOKEN_FILE: "/var/run/secrets/kobe/bootstrap-token",
    });
    expect(config.bootstrapTokenFile).toBe("/var/run/secrets/kobe/bootstrap-token");
    expect(() =>
      loadConfig({ KOBE_SERVER_URL: "ws://kobe", KOBE_BOOTSTRAP_TOKEN_FILE: "relative/path" }),
    ).toThrow(/KOBE_BOOTSTRAP_TOKEN_FILE/);
  });

  it("requires a lowercase uuid sandbox id", () => {
    expect(() => loadConfig({ KOBE_SERVER_URL: "wss://kobe" })).toThrow(/KOBE_SANDBOX_ID/);
    expect(() =>
      loadConfig({ KOBE_SERVER_URL: "wss://kobe", KOBE_SANDBOX_ID: SANDBOX.toUpperCase() }),
    ).toThrow(/KOBE_SANDBOX_ID/);
  });

  it("defaults to the image layout", () => {
    const config = loadConfig({ ...base, KOBE_SERVER_URL: "wss://kobe" });
    expect(config).toMatchObject({
      tokenFile: "/var/run/kobe/sandbox-wire/token",
      workspaceDir: "/workspace",
      sessionDir: "/workspace/.kobe/sessions",
      piBin: "pi",
      maxPiProcesses: 8,
    });
  });

  it("rejects relative directories", () => {
    expect(() =>
      loadConfig({ ...base, KOBE_SERVER_URL: "wss://kobe", KOBE_SESSION_DIR: "sessions" }),
    ).toThrow(/KOBE_SESSION_DIR/);
  });

  it("takes the Pi identity helper (KOBE-71) as an absolute path, off by default", () => {
    const url = { ...base, KOBE_SERVER_URL: "ws://kobe-server:8080" };
    expect(loadConfig(url).piRunAs).toBeUndefined();
    expect(loadConfig({ ...url, KOBE_PI_RUNAS: "/opt/kobe/bin/kobe-runas" }).piRunAs).toBe(
      "/opt/kobe/bin/kobe-runas",
    );
    expect(() => loadConfig({ ...url, KOBE_PI_RUNAS: "kobe-runas" })).toThrow(/KOBE_PI_RUNAS/);
  });
});
