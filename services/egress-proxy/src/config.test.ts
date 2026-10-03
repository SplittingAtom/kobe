import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const KEY = "s".repeat(40);
const base = { KOBE_DATABASE_URL: "postgres://app@db/kobe", KOBE_SESSION_KEY_EGRESS_PROXY: KEY };

describe("loadConfig", () => {
  it("defaults: port 8080, HTTPS only, limits on", () => {
    const c = loadConfig(base);
    expect(c.port).toBe(8080);
    expect(c.allowedPorts).toEqual([443]);
    expect(c.allowedInternalCidrs).toEqual([]);
    expect(c.maxConnectionsPerSandbox).toBe(64);
    expect(c.bandwidthBytesPerSecond).toBeGreaterThan(0);
  });

  it("reads PORT, ports and CIDR lists from the environment", () => {
    const c = loadConfig({
      ...base,
      PORT: "9090",
      KOBE_EGRESS_ALLOWED_PORTS: "443, 8443",
      KOBE_EGRESS_ALLOWED_INTERNAL_CIDRS: "10.43.200.200/32",
      KOBE_EGRESS_DENIED_CIDRS: "11.0.0.0/8,fd00::/8",
    });
    expect(c.port).toBe(9090);
    expect(c.allowedPorts).toEqual([443, 8443]);
    expect(c.allowedInternalCidrs).toEqual(["10.43.200.200/32"]);
    expect(c.deniedCidrs).toEqual(["11.0.0.0/8", "fd00::/8"]);
  });

  it("rejects invalid values with a clear error and never echoes the key", () => {
    expect(() => loadConfig({ ...base, PORT: "70000" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, KOBE_EGRESS_ALLOWED_PORTS: "0" })).toThrow(/ALLOWED_PORTS/);
    expect(() => loadConfig({ ...base, KOBE_EGRESS_DENIED_CIDRS: "10.0.0.0/99" })).toThrow(
      /DENIED_CIDRS/,
    );
    expect(() => loadConfig({ KOBE_DATABASE_URL: "x" })).toThrow(/KOBE_SESSION_KEY_EGRESS_PROXY/);
    let message = "";
    try {
      loadConfig({ ...base, KOBE_SESSION_KEY_EGRESS_PROXY: "short-secret" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/at least 32/);
    expect(message).not.toContain("short-secret");
  });
});
