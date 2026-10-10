import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverAuthServer } from "./discovery.js";
import { oauthRequest, type OauthIo } from "./http.js";
import { FakeOauthServer } from "../../testing/fake-oauth-server.js";

const fake = new FakeOauthServer();
beforeAll(() => fake.start());
afterAll(() => fake.close());

/** A name that resolves to a public address for the first lookup and `later` after that. */
function rebinding(later: string): { io: OauthIo; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    io: {
      timeoutMs: 2000,
      policy: {
        allowHttp: true,
        allowedPorts: [fake.port],
        allowedInternalCidrs: [],
        deniedCidrs: [],
        resolve: () => Promise.resolve(++n === 1 ? ["93.184.216.34"] : [later]),
      },
    },
  };
}
const local: OauthIo = {
  timeoutMs: 2000,
  policy: {
    allowHttp: true,
    allowedPorts: [0],
    allowedInternalCidrs: ["127.0.0.0/8"],
    deniedCidrs: [],
    resolve: () => Promise.resolve(["127.0.0.1"]),
  },
};

describe("pinned connections", () => {
  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254"])(
    "refuses a name that re-resolves to %s at connect time",
    async (later) => {
      const { io, calls } = rebinding(later);
      fake.hits.length = 0;
      await expect(
        oauthRequest(io, `http://rebind.test:${fake.port}/mcp`, {}, "oauth_unreachable"),
      ).rejects.toMatchObject({ code: "oauth_unreachable" });
      expect(calls()).toBeGreaterThanOrEqual(2);
      expect(fake.hits).toEqual([]);
    },
  );

  it("does not follow a redirect to an internal address", async () => {
    fake.options = { redirectTo: "http://127.0.0.1:1/secret" };
    const io = { ...local, policy: { ...local.policy, allowedPorts: [fake.port] } };
    try {
      fake.hits.length = 0;
      await expect(
        oauthRequest(io, `${fake.base}/redirect`, {}, "oauth_unreachable"),
      ).rejects.toMatchObject({ code: "oauth_unreachable" });
      expect(fake.hits).toEqual(["/redirect"]);
    } finally {
      fake.options = {};
    }
  });

  it("caps the response size", async () => {
    const io = { ...local, policy: { ...local.policy, allowedPorts: [fake.port] } };
    await expect(
      oauthRequest(io, `${fake.base}/big`, {}, "oauth_unreachable"),
    ).rejects.toMatchObject({ code: "oauth_unreachable" });
  });

  it("uses the WWW-Authenticate resource_metadata hint", async () => {
    fake.options = { prmHint: true };
    const io = { ...local, policy: { ...local.policy, allowedPorts: [fake.port] } };
    try {
      const info = await discoverAuthServer(io, fake.mcpUrl);
      expect(info.issuer).toBe(fake.base);
      expect(fake.hits).toContain("/custom-prm");
    } finally {
      fake.options = {};
    }
  });
});
