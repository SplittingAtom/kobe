import { describe, expect, it } from "vitest";
import { checkConnectorUrl, type ConnectorUrlPolicy } from "./url-policy.js";

const resolving =
  (...addresses: string[]) =>
  async () =>
    addresses;
const policy = (over: Partial<ConnectorUrlPolicy> = {}): ConnectorUrlPolicy => ({
  allowHttp: false,
  allowedPorts: [443],
  allowedInternalCidrs: [],
  deniedCidrs: [],
  resolve: resolving("93.184.216.34"),
  ...over,
});

describe("checkConnectorUrl", () => {
  it("accepts a public https URL and normalizes it", async () => {
    const r = await checkConnectorUrl("https://MCP.Example.com/mcp?x=1", policy());
    expect(r).toEqual({ ok: true, url: "https://mcp.example.com/mcp?x=1" });
  });

  it.each([
    ["http://mcp.example.com/mcp", "https_required"],
    ["ftp://mcp.example.com/mcp", "https_required"],
    ["not a url", "invalid_url"],
    ["https://user:pw@mcp.example.com/mcp", "credentials_in_url"],
    ["https://mcp.example.com/mcp#frag", "invalid_url"],
    ["https://mcp.example.com:8443/mcp", "port_not_allowed"],
  ])("refuses %s", async (url, code) => {
    const r = await checkConnectorUrl(url, policy());
    expect(r).toMatchObject({ ok: false, code });
  });

  it.each([
    "https://127.0.0.1/mcp",
    "https://10.1.2.3/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/mcp",
    "https://[fe80::1]/mcp",
    "https://[::ffff:10.0.0.1]/mcp",
  ])("refuses literal address %s", async (url) => {
    const r = await checkConnectorUrl(url, policy());
    expect(r).toMatchObject({ ok: false, code: "address_not_allowed" });
  });

  it("refuses a name that resolves to any private address", async () => {
    const r = await checkConnectorUrl(
      "https://mcp.example.com/mcp",
      policy({ resolve: resolving("93.184.216.34", "10.0.0.5") }),
    );
    expect(r).toMatchObject({ ok: false, code: "address_not_allowed" });
  });

  it("refuses a name that does not resolve", async () => {
    const r = await checkConnectorUrl(
      "https://nope.example.com/mcp",
      policy({
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    );
    expect(r).toMatchObject({ ok: false, code: "host_unresolvable" });
  });

  it("allows an internal target the operator listed, and the extra denied ranges", async () => {
    const internal = policy({
      allowedInternalCidrs: ["10.0.5.0/24"],
      resolve: resolving("10.0.5.7"),
    });
    expect(await checkConnectorUrl("https://mcp.corp.test/mcp", internal)).toMatchObject({
      ok: true,
    });
    const denied = policy({ deniedCidrs: ["93.184.216.0/24"] });
    expect(await checkConnectorUrl("https://mcp.example.com/mcp", denied)).toMatchObject({
      ok: false,
      code: "address_not_allowed",
    });
  });

  it("accepts http only with the dev flag, still address-checked", async () => {
    const dev = policy({ allowHttp: true, allowedPorts: [443, 80] });
    expect(await checkConnectorUrl("http://mcp.example.com/mcp", dev)).toMatchObject({ ok: true });
    expect(await checkConnectorUrl("http://127.0.0.1/mcp", dev)).toMatchObject({
      ok: false,
      code: "address_not_allowed",
    });
  });
});
