import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const ENV = {
  KOBE_SESSION_KEY_MCP_PROXY: "s".repeat(32),
  KOBE_MCP_INTERNAL_KEY: "i".repeat(32),
  KOBE_MCP_SERVER_URL: "http://kobe-server:8082/",
};

describe("loadConfig", () => {
  it("applies defaults: port 8080, HTTPS on 443 only, nothing internal", () => {
    const config = loadConfig(ENV);
    expect(config.port).toBe(8080);
    expect(config.serverUrl).toBe("http://kobe-server:8082");
    expect(config.upstream).toEqual({
      allowInsecureHttp: false,
      allowedPorts: [443],
      allowedInternalCidrs: [],
      deniedCidrs: [],
    });
    expect(config.limits.maxRequestBytes).toBe(1024 * 1024);
    expect(config.limits.upstreamTimeoutMs).toBeLessThan(60_000);
  });

  it("reads lists and switches", () => {
    const config = loadConfig({
      ...ENV,
      PORT: "9090",
      KOBE_MCP_ALLOW_INSECURE_HTTP: "true",
      KOBE_MCP_ALLOWED_PORTS: "443, 8443",
      KOBE_MCP_ALLOWED_INTERNAL_CIDRS: "10.0.5.0/24",
      KOBE_MCP_DENIED_CIDRS: "100.100.0.0/16",
    });
    expect(config.port).toBe(9090);
    expect(config.upstream).toEqual({
      allowInsecureHttp: true,
      allowedPorts: [443, 8443],
      allowedInternalCidrs: ["10.0.5.0/24"],
      deniedCidrs: ["100.100.0.0/16"],
    });
  });

  it.each([
    ["no session key", { KOBE_SESSION_KEY_MCP_PROXY: undefined }, /KOBE_SESSION_KEY_MCP_PROXY/],
    ["a short internal key", { KOBE_MCP_INTERNAL_KEY: "short" }, /KOBE_MCP_INTERNAL_KEY/],
    ["no server URL", { KOBE_MCP_SERVER_URL: undefined }, /KOBE_MCP_SERVER_URL/],
    ["a bad port", { PORT: "70000" }, /PORT/],
    ["a bad CIDR", { KOBE_MCP_ALLOWED_INTERNAL_CIDRS: "nope" }, /CIDRs/],
    ["a bad upstream port", { KOBE_MCP_ALLOWED_PORTS: "0" }, /KOBE_MCP_ALLOWED_PORTS/],
    ["a bad switch", { KOBE_MCP_ALLOW_INSECURE_HTTP: "yes" }, /KOBE_MCP_ALLOW_INSECURE_HTTP/],
    ["the same key twice", { KOBE_MCP_INTERNAL_KEY: "s".repeat(32) }, /must differ/],
  ])("rejects %s with a clear error", (_, override, message) => {
    expect(() => loadConfig({ ...ENV, ...override })).toThrow(message);
  });

  it("never echoes key values in errors", () => {
    try {
      loadConfig({ ...ENV, KOBE_MCP_INTERNAL_KEY: "secret-but-short" });
    } catch (err) {
      expect(String(err)).not.toContain("secret-but-short");
    }
  });
});
