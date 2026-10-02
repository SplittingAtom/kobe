import { describe, expect, it, vi } from "vitest";
import type { AllowlistCache } from "./allowlist.js";
import { applyChangeHint } from "./change-listener.js";

const TEAM = "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e";
const USER = "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70";

function cache() {
  return {
    invalidateAll: vi.fn(),
    invalidateCeiling: vi.fn(),
    invalidateTeam: vi.fn(),
    invalidateUser: vi.fn(),
  };
}

describe("applyChangeHint", () => {
  it("maps each hint to its invalidation and the tunnels to re-check", () => {
    const c = cache();
    const asCache = c as unknown as AllowlistCache;
    expect(applyChangeHint(asCache, "ceiling")).toEqual({ kind: "ceiling" });
    expect(c.invalidateCeiling).toHaveBeenCalled();
    expect(applyChangeHint(asCache, TEAM.toUpperCase())).toEqual({ kind: "team", teamId: TEAM });
    expect(c.invalidateTeam).toHaveBeenCalledWith(TEAM);
    expect(applyChangeHint(asCache, `user:${USER}`)).toEqual({ kind: "user", userId: USER });
    expect(c.invalidateUser).toHaveBeenCalledWith(USER);
  });

  it("flushes everything on anything it does not understand", () => {
    const c = cache();
    for (const junk of [undefined, "", "user:nope", "team:x"]) {
      expect(applyChangeHint(c as unknown as AllowlistCache, junk)).toEqual({ kind: "all" });
    }
    expect(c.invalidateAll).toHaveBeenCalledTimes(4);
  });
});
