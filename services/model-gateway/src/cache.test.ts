import { describe, expect, it } from "vitest";
import { TtlCache } from "./cache.js";

describe("TtlCache invalidation", () => {
  it("does not cache a load that began before an invalidation", async () => {
    const cache = new TtlCache<string>({ ttlMs: 60_000 });
    let release: (v: string) => void = () => undefined;
    const slow = cache.get("k", () => new Promise<string>((r) => (release = r)));
    cache.deleteWhere(() => true);
    release("stale");
    expect(await slow).toBe("stale");
    // The stale value was not kept: the next get loads again.
    expect(await cache.get("k", async () => "fresh")).toBe("fresh");
  });

  it("starts a new load after an invalidation instead of joining the old one", async () => {
    const cache = new TtlCache<string>({ ttlMs: 60_000 });
    const old = cache.get("k", () => new Promise<string>(() => undefined));
    cache.clear();
    expect(await cache.get("k", async () => "new")).toBe("new");
    void old;
  });
});
