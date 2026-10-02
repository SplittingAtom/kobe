import { BlockList } from "node:net";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { clientIp } from "./context.js";

async function ipFor(xff: string | undefined, trusted: string[]): Promise<string | null> {
  const list = new BlockList();
  for (const cidr of trusted) {
    const [address = "", prefix = "32"] = cidr.split("/");
    list.addSubnet(address, Number(prefix), "ipv4");
  }
  const app = new Hono();
  let seen: string | null = "unset";
  app.get("/", (c) => {
    seen = clientIp(c, list, trusted.length > 0);
    return c.body(null, 204);
  });
  await app.request("/", { headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
  return seen;
}

describe("clientIp (audit request metadata)", () => {
  it("takes the rightmost hop that is not a trusted proxy", async () => {
    expect(await ipFor("203.0.113.7, 10.0.0.5", ["10.0.0.0/8"])).toBe("203.0.113.7");
    expect(await ipFor("1.1.1.1, 203.0.113.7, 10.0.0.5", ["10.0.0.0/8"])).toBe("203.0.113.7");
  });

  it("ignores spoofable headers it can't attribute", async () => {
    expect(await ipFor("203.0.113.7, 198.51.100.1", [])).toBeNull();
    expect(await ipFor("garbage, 10.0.0.5", ["10.0.0.0/8"])).toBeNull();
    expect(await ipFor("10.0.0.5", ["10.0.0.0/8"])).toBeNull();
  });

  it("accepts a single hop without trusted proxies, and nothing without a header or socket", async () => {
    expect(await ipFor("203.0.113.7", [])).toBe("203.0.113.7");
    expect(await ipFor(undefined, [])).toBeNull();
  });
});
