import { describe, expect, it, vi } from "vitest";
import { AllowlistCache, type EgressPolicySource } from "./allowlist.js";

const TEAM = "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e";
const OTHER = "1c6f9a2d-3e4b-4c6d-9eaf-1a2b3c4d5e6f";

function setup(initial: { ceiling: string[]; teams: Record<string, string[]> }) {
  const state = { ...initial, members: new Set<string>([`${TEAM}:u1`]) };
  const source = {
    loadCeiling: vi.fn(async () => [...state.ceiling]),
    loadTeam: vi.fn(async (t: string) => [...(state.teams[t] ?? [])]),
    isActiveMember: vi.fn(async (t: string, u: string) => state.members.has(`${t}:${u}`)),
  } satisfies EgressPolicySource;
  let t = 0;
  const cache = new AllowlistCache(source, {
    ttlMs: 60_000,
    degradedTtlMs: 5_000,
    memberTtlMs: 30_000,
    maxEntries: 100,
    now: () => t,
  });
  cache.setListening(true);
  return { state, source, cache, advance: (ms: number) => (t += ms) };
}

describe("AllowlistCache.decide", () => {
  it("fresh install: nothing is allowed; registries are in the ceiling but not enabled", async () => {
    const { cache } = setup({ ceiling: ["pypi.org"], teams: {} });
    expect(await cache.decide(TEAM, "pypi.org")).toEqual({ allowed: false, reason: "not_enabled" });
    expect(await cache.decide(TEAM, "example.com")).toEqual({
      allowed: false,
      reason: "not_in_ceiling",
    });
  });

  it("allows only what the team enabled and the ceiling still contains", async () => {
    const { cache } = setup({
      ceiling: ["pypi.org", "*.github.com"],
      teams: { [TEAM]: ["pypi.org", "*.github.com", "gitlab.com"] },
    });
    expect(await cache.decide(TEAM, "pypi.org")).toEqual({ allowed: true, pattern: "pypi.org" });
    expect(await cache.decide(TEAM, "api.github.com")).toEqual({
      allowed: true,
      pattern: "*.github.com",
    });
    // Enabled by the team but no longer in the ceiling: blocked.
    expect(await cache.decide(TEAM, "gitlab.com")).toEqual({
      allowed: false,
      reason: "not_in_ceiling",
    });
    // Another team enabled nothing.
    expect((await cache.decide(OTHER, "pypi.org")).allowed).toBe(false);
  });

  it("caches, and re-reads after a team or ceiling change hint", async () => {
    const { state, source, cache } = setup({ ceiling: ["pypi.org"], teams: {} });
    await cache.decide(TEAM, "pypi.org");
    await cache.decide(TEAM, "pypi.org");
    expect(source.loadTeam).toHaveBeenCalledTimes(1);
    state.teams[TEAM] = ["pypi.org"];
    cache.invalidateTeam(TEAM);
    expect((await cache.decide(TEAM, "pypi.org")).allowed).toBe(true);
    state.ceiling = [];
    cache.invalidateCeiling();
    expect(await cache.decide(TEAM, "pypi.org")).toEqual({
      allowed: false,
      reason: "not_in_ceiling",
    });
    expect(source.loadTeam).toHaveBeenCalledTimes(2);
  });

  it("expires entries after the TTL, sooner while change hints are not arriving", async () => {
    const { source, cache, advance } = setup({ ceiling: [], teams: {} });
    await cache.decide(TEAM, "a.com");
    advance(10_000);
    await cache.decide(TEAM, "a.com");
    expect(source.loadTeam).toHaveBeenCalledTimes(1);
    cache.setListening(false);
    await cache.decide(TEAM, "a.com");
    expect(source.loadTeam).toHaveBeenCalledTimes(2);
  });

  it("never caches a load that was invalidated while it ran", async () => {
    const { state, source, cache } = setup({ ceiling: ["pypi.org"], teams: {} });
    let release: () => void = () => undefined;
    source.loadTeam.mockImplementationOnce(() => new Promise((r) => (release = () => r([]))));
    const first = cache.decide(TEAM, "pypi.org");
    state.teams[TEAM] = ["pypi.org"];
    cache.invalidateTeam(TEAM);
    release();
    expect((await first).allowed).toBe(false);
    expect((await cache.decide(TEAM, "pypi.org")).allowed).toBe(true);
  });

  it("shares one load between concurrent callers and propagates failures (fail closed)", async () => {
    const { source, cache } = setup({ ceiling: [], teams: {} });
    await Promise.all([cache.decide(TEAM, "a.com"), cache.decide(TEAM, "b.com")]);
    expect(source.loadTeam).toHaveBeenCalledTimes(1);
    cache.invalidateAll();
    source.loadCeiling.mockRejectedValueOnce(new Error("db down"));
    await expect(cache.decide(TEAM, "a.com")).rejects.toThrow("db down");
  });
});

describe("AllowlistCache.isActiveMember", () => {
  it("caches membership briefly and drops it with the team's hint", async () => {
    const { state, source, cache, advance } = setup({ ceiling: [], teams: {} });
    expect(await cache.isActiveMember(TEAM, "u1")).toBe(true);
    state.members.clear();
    expect(await cache.isActiveMember(TEAM, "u1")).toBe(true);
    advance(31_000);
    expect(await cache.isActiveMember(TEAM, "u1")).toBe(false);
    state.members.add(`${TEAM}:u1`);
    cache.invalidateTeam(TEAM);
    expect(await cache.isActiveMember(TEAM, "u1")).toBe(true);
    expect(source.isActiveMember).toHaveBeenCalledTimes(3);
  });
});
