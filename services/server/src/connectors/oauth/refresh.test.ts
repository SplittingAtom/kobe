import { describe, expect, it } from "vitest";
import type { OauthBundle } from "./bundle.js";
import type { OauthIo } from "./http.js";
import { refreshAccessToken } from "./refresh.js";

const bundle = (tokenEndpoint: string): OauthBundle => ({
  v: 1,
  access_token: "a",
  refresh_token: "r",
  client_id: "c",
  token_endpoint: tokenEndpoint,
  issuer: "https://as.example",
  resource: "https://mcp.example/mcp",
});
const io = (address: string): OauthIo => ({
  timeoutMs: 1000,
  policy: {
    allowHttp: true,
    allowedPorts: [80, 443],
    allowedInternalCidrs: [],
    deniedCidrs: [],
    resolve: () => Promise.resolve([address]),
  },
});

describe("refreshAccessToken address policy", () => {
  it.each(["127.0.0.1", "10.0.0.5", "169.254.169.254"])(
    "never connects to a token endpoint that resolves to %s",
    async (address) => {
      await expect(
        refreshAccessToken(io(address), bundle("https://as.example/token"), new Date()),
      ).rejects.toMatchObject({ code: expect.stringMatching(/unsupported|unreachable/) });
    },
  );

  it("needs a refresh token", async () => {
    const { refresh_token: _drop, ...without } = bundle("https://as.example/token");
    await expect(
      refreshAccessToken(io("93.184.216.34"), without, new Date()),
    ).rejects.toMatchObject({ code: "refresh_rejected" });
  });

  it("puts the DNS pre-check under the same deadline", async () => {
    const hanging: OauthIo = {
      timeoutMs: 150,
      policy: { ...io("1.1.1.1").policy, resolve: () => new Promise(() => undefined) },
    };
    const started = Date.now();
    await expect(
      refreshAccessToken(hanging, bundle("https://as.example/token"), new Date()),
    ).rejects.toMatchObject({ code: "oauth_unreachable" });
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
