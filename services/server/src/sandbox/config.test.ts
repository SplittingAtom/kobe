import { generateSessionKeyPair } from "@kobe/session-token";
import { describe, expect, it } from "vitest";
import { createSandboxRuntime } from "./runtime.js";
import { KEYS, KEY_PAIRS, SETTINGS } from "../testing/sandbox-fixtures.js";
import {
  loadSandboxConfig,
  loadSandboxSettings,
  quantityBytes,
  signingKeyEnvName,
} from "./config.js";

const env = (over: Record<string, string | undefined> = {}) => ({
  KOBE_SANDBOX_CONFIG: JSON.stringify(SETTINGS),
  KOBE_SESSION_SIGNING_KEY_SANDBOX_WIRE: KEY_PAIRS["kobe.sandbox-wire"].privatePem,
  KOBE_SESSION_SIGNING_KEY_MODEL_GATEWAY: KEY_PAIRS["kobe.model-gateway"].privatePem,
  KOBE_SESSION_SIGNING_KEY_MCP_PROXY: KEY_PAIRS["kobe.mcp-proxy"].privatePem,
  KOBE_SESSION_SIGNING_KEY_EGRESS_PROXY: KEY_PAIRS["kobe.egress-proxy"].privatePem,
  ...over,
});

describe("sandbox config", () => {
  it("loads provider-only settings with none of the four session keys (the scheduler, KOBE-174)", () => {
    const bare = { KOBE_SANDBOX_CONFIG: JSON.stringify(SETTINGS) };
    expect(() => loadSandboxConfig(bare)).toThrow(/KOBE_SESSION_SIGNING_KEY_/);
    expect(loadSandboxSettings(bare)).toEqual(SETTINGS);
    expect(loadSandboxSettings({})).toBeUndefined();
  });

  it("builds the sandbox provider without keys, exposing none", () => {
    const rt = createSandboxRuntime(
      { KOBE_SANDBOX_CONFIG: JSON.stringify(SETTINGS), KOBE_RUNTIME_CLASS: "gvisor" },
      { require: () => Promise.reject(new Error("not needed")) } as never,
      undefined,
      { providerOnly: true },
    );
    expect(rt?.provider).toBeDefined();
    expect(rt).not.toHaveProperty("sessionKeys");
  });

  it("parses the chart's settings and one key pair per audience", () => {
    const loaded = loadSandboxConfig(env());
    expect(loaded?.settings).toEqual(SETTINGS);
    for (const aud of Object.keys(KEYS) as (keyof typeof KEYS)[]) {
      expect(loaded?.sessionKeys[aud].kid).toBe(KEYS[aud].kid);
      // Without a rotation bundle the server verifies with its own key only.
      expect([...(loaded?.sessionVerifyKeys[aud].keys() ?? [])]).toEqual([KEYS[aud].kid]);
    }
  });

  it("rotation: verifies with its own key plus the previous one from the verify bundle", () => {
    const previous = generateSessionKeyPair();
    const loaded = loadSandboxConfig(
      env({
        KOBE_SESSION_VERIFY_KEY_MCP_PROXY: `${KEY_PAIRS["kobe.mcp-proxy"].publicPem}${previous.publicPem}`,
      }),
    );
    expect([...(loaded?.sessionVerifyKeys["kobe.mcp-proxy"].keys() ?? [])].sort()).toEqual(
      [KEYS["kobe.mcp-proxy"].kid, previous.signing.kid].sort(),
    );
  });

  it("defaults the tool executor (KOBE-167) to off when the chart predates it, and reads it", () => {
    const { toolExecutor: _te, ...older } = SETTINGS;
    const loaded = loadSandboxConfig(env({ KOBE_SANDBOX_CONFIG: JSON.stringify(older) }));
    expect(loaded?.settings.toolExecutor).toEqual({ enabled: false });
    const on = loadSandboxConfig(
      env({
        KOBE_SANDBOX_CONFIG: JSON.stringify({ ...SETTINGS, toolExecutor: { enabled: true } }),
      }),
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
    expect(signingKeyEnvName("kobe.sandbox-wire")).toBe("KOBE_SESSION_SIGNING_KEY_SANDBOX_WIRE");
    expect(signingKeyEnvName("kobe.egress-proxy")).toBe("KOBE_SESSION_SIGNING_KEY_EGRESS_PROXY");
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
    [
      "a missing key",
      { KOBE_SESSION_SIGNING_KEY_MCP_PROXY: undefined },
      /KOBE_SESSION_SIGNING_KEY_MCP_PROXY is required/,
    ],
    [
      "an HMAC string instead of a PEM key",
      { KOBE_SESSION_SIGNING_KEY_MCP_PROXY: "s".repeat(48) },
      /PRIVATE KEY/,
    ],
    [
      "a public key where the private key belongs",
      { KOBE_SESSION_SIGNING_KEY_MCP_PROXY: KEY_PAIRS["kobe.mcp-proxy"].publicPem },
      /PRIVATE KEY/,
    ],
    [
      "a key shared between audiences",
      { KOBE_SESSION_SIGNING_KEY_MCP_PROXY: KEY_PAIRS["kobe.sandbox-wire"].privatePem },
      /must all differ/,
    ],
    [
      "a private key in a verify bundle",
      { KOBE_SESSION_VERIFY_KEY_MCP_PROXY: KEY_PAIRS["kobe.mcp-proxy"].privatePem },
      /public keys only/,
    ],
  ])("fails fast on %s", (_, over, message) => {
    expect(() => loadSandboxConfig(env(over))).toThrow(message);
  });

  it("never echoes key values in errors", () => {
    const secret = "s".repeat(20);
    expect(() => loadSandboxConfig(env({ KOBE_SESSION_SIGNING_KEY_MCP_PROXY: secret }))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }),
    );
  });
});
