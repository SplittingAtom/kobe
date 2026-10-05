import { describe, expect, it } from "vitest";
import { loadConnectorUrlPolicy } from "./config.js";

describe("loadConnectorUrlPolicy", () => {
  it("defaults to https on 443 with no internal targets", () => {
    expect(loadConnectorUrlPolicy({})).toMatchObject({
      allowHttp: false,
      allowedPorts: [443],
      allowedInternalCidrs: [],
      deniedCidrs: [],
    });
  });

  it("reads the proxy's variables", () => {
    expect(
      loadConnectorUrlPolicy({
        KOBE_MCP_ALLOW_INSECURE_HTTP: "true",
        KOBE_MCP_ALLOWED_PORTS: "443, 8443",
        KOBE_MCP_ALLOWED_INTERNAL_CIDRS: "10.0.5.0/24",
        KOBE_MCP_DENIED_CIDRS: "172.20.0.0/16",
      }),
    ).toMatchObject({
      allowHttp: true,
      allowedPorts: [443, 8443],
      allowedInternalCidrs: ["10.0.5.0/24"],
      deniedCidrs: ["172.20.0.0/16"],
    });
  });

  it.each([
    { KOBE_MCP_ALLOW_INSECURE_HTTP: "yes" },
    { KOBE_MCP_ALLOWED_PORTS: "0" },
    { KOBE_MCP_ALLOWED_INTERNAL_CIDRS: "nope" },
  ])("fails fast on %o", (env) => {
    expect(() => loadConnectorUrlPolicy(env)).toThrow(/Invalid configuration/);
  });
});
