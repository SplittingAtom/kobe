import { describe, expect, it } from "vitest";
import { KEYS, SETTINGS } from "../testing/sandbox-fixtures.js";
import { loadSandboxConfig, quantityBytes, sessionKeyEnvName } from "./config.js";

const env = (over: Record<string, string | undefined> = {}) => ({
  KOBE_SANDBOX_CONFIG: JSON.stringify(SETTINGS),
  KOBE_SESSION_KEY_SANDBOX_WIRE: KEYS["kobe.sandbox-wire"],
  KOBE_SESSION_KEY_MODEL_GATEWAY: KEYS["kobe.model-gateway"],
  KOBE_SESSION_KEY_MCP_PROXY: KEYS["kobe.mcp-proxy"],
  KOBE_SESSION_KEY_EGRESS_PROXY: KEYS["kobe.egress-proxy"],
  ...over,
});

describe("sandbox config", () => {
  it("parses the chart's settings and one key per audience", () => {
    expect(loadSandboxConfig(env())).toEqual({ settings: SETTINGS, sessionKeys: KEYS });
  });

  it("defaults the tool executor (KOBE-167) to off when the chart predates it, and reads it", () => {
    const { toolExecutor: _te, ...older } = SETTINGS;
    const loaded = loadSandboxConfig(env({ KOBE_SANDBOX_CONFIG: JSON.stringify(older) }));
    expect(loaded?.settings.toolExecutor).toEqual({ enabled: false });
    const on = loadSandboxConfig(
      env({ KOBE_SANDBOX_CONFIG: JSON.stringify({ ...SETTINGS, toolExecutor: { enabled: true } }) }),
    );
    expect(on?.settings.toolExecutor).toEqual({ enabled: true });
  });

  it("defaults workspace sync (KOBE-27) when the chart predates it, and reads quantities as bytes", () => {
    const { workspaceSync: _ws, ...older } = SETTINGS;
    const loaded = loadSandboxConfig(env({ KOBE_SANDBOX_CONFIG: JSON.stringify(older) }));
    expect(loaded?.settings.workspaceSync).toEqual(SETTINGS.workspaceSync);
    expect(quantityBytes("10Gi")).toBe(10 * 2 ** 30);
    expect(quantityBytes("512Mi")).toBe(512 * 2 ** 20);
    expect(quantityBytes("1G")).toBe(1e9);
    expect(quantityBytes("100")).toBe(100);
    expect(() =>
      loadSandboxConfig(
        env({
          KOBE_SANDBOX_CONFIG: JSON.stringify({
            ...SETTINGS,
            workspaceSync: { ...SETTINGS.workspaceSync, pushIntervalSeconds: 1 },
          }),
        }),
      ),
    ).toThrow(/pushIntervalSeconds/);
  });

  it("names key variables after their audience", () => {
    expect(sessionKeyEnvName("kobe.sandbox-wire")).toBe("KOBE_SESSION_KEY_SANDBOX_WIRE");
    expect(sessionKeyEnvName("kobe.egress-proxy")).toBe("KOBE_SESSION_KEY_EGRESS_PROXY");
  });

  it("is disabled (undefined) when the chart does not configure sandboxes", () => {
    expect(loadSandboxConfig({})).toBeUndefined();
    expect(loadSandboxConfig({ KOBE_SANDBOX_CONFIG: "  " })).toBeUndefined();
  });

  it.each([
    ["not JSON", { KOBE_SANDBOX_CONFIG: "{" }, /not valid JSON/],
    [
      "a bad quantity",
      { KOBE_SANDBOX_CONFIG: JSON.stringify({ ...SETTINGS, tmpSize: "lots" }) },
      /tmpSize/,
    ],
    [
      "unknown keys",
      { KOBE_SANDBOX_CONFIG: JSON.stringify({ ...SETTINGS, privileged: true }) },
      /privileged|Unrecognized/,
    ],
    [
      "a missing endpoint",
      {
        KOBE_SANDBOX_CONFIG: JSON.stringify({
          ...SETTINGS,
          endpoints: { ...SETTINGS.endpoints, egressProxy: undefined },
        }),
      },
      /egressProxy/,
    ],
    ["a missing key", { KOBE_SESSION_KEY_MCP_PROXY: undefined }, /KOBE_SESSION_KEY_MCP_PROXY/],
    ["a short key", { KOBE_SESSION_KEY_MCP_PROXY: "short" }, /at least 32/],
    [
      "a key shared between audiences",
      { KOBE_SESSION_KEY_MCP_PROXY: KEYS["kobe.sandbox-wire"] },
      /must all differ/,
    ],
  ])("fails fast on %s", (_, over, message) => {
    expect(() => loadSandboxConfig(env(over))).toThrow(message);
  });

  it("never echoes key values in errors", () => {
    const secret = "s".repeat(20);
    expect(() => loadSandboxConfig(env({ KOBE_SESSION_KEY_MCP_PROXY: secret }))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }),
    );
  });
});
