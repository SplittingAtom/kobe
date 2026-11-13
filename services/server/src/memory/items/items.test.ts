import { describe, expect, it } from "vitest";
import { SITE_SWITCHES_ON, WORKSPACE_SWITCHES_ON, effectiveMemory } from "../switch-model.js";
import { normaliseTags, sameTags } from "./context.js";
import { MemoryItemError } from "./errors.js";
import { nearFullAt } from "./limits.js";
import { assertEnabled, assertMayWrite, curates, type MemoryWho } from "./who.js";

const who = (over: Partial<MemoryWho> = {}): MemoryWho => ({
  userId: "u",
  teamId: "t",
  teamRole: "member",
  memorySteward: false,
  siteRole: null,
  grants: [],
  ...over,
});

const code = (fn: () => void) => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as MemoryItemError).code;
  }
};

describe("item store rules (KOBE-378)", () => {
  it("notifies at the first count reaching 80% of the limit", () => {
    expect([
      nearFullAt(5),
      nearFullAt(50),
      nearFullAt(300),
      nearFullAt(1000),
      nearFullAt(1),
    ]).toEqual([4, 40, 240, 800, 1]);
  });

  it("stores tags trimmed, lowercased and once", () => {
    expect(normaliseTags(["Ops", "ops", "FOOD", " x "])).toEqual(["ops", "food", "x"]);
    expect(sameTags(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameTags(["a", "b"], ["b", "a"])).toBe(false);
  });

  it("maps refusals to the contract's statuses", () => {
    expect(new MemoryItemError("memory_scope_full", "x").status).toBe(409);
    expect(new MemoryItemError("memory_pin_limit", "x").status).toBe(409);
    expect(new MemoryItemError("memory_disabled", "x").status).toBe(403);
    expect(new MemoryItemError("invalid_request", "x").status).toBe(400);
  });

  it("lets owners write personal scopes, curators Workspace items, admins Policy", () => {
    expect(code(() => assertMayWrite(who(), "user"))).toBeUndefined();
    expect(code(() => assertMayWrite(who(), "portable"))).toBeUndefined();
    expect(code(() => assertMayWrite(who(), "team"))).toBe("memory_not_allowed");
    expect(code(() => assertMayWrite(who({ memorySteward: true }), "team"))).toBeUndefined();
    expect(code(() => assertMayWrite(who({ teamRole: "team_admin" }), "team"))).toBeUndefined();
    expect(code(() => assertMayWrite(who({ teamRole: "team_admin" }), "site"))).toBe(
      "memory_not_allowed",
    );
    const steward = who({ grants: ["memory_steward"] });
    expect(code(() => assertMayWrite(steward, "site"))).toBeUndefined();
    for (const shape of [
      { policyField: true, targetIsPolicy: false },
      { policyField: false, targetIsPolicy: true },
    ])
      expect(code(() => assertMayWrite(steward, "site", shape))).toBe("memory_not_allowed");
    expect(
      code(() =>
        assertMayWrite(who({ siteRole: "admin" }), "site", {
          policyField: true,
          targetIsPolicy: true,
        }),
      ),
    ).toBeUndefined();
    expect(curates(who({ memorySteward: true, teamRole: "member" }), "site")).toBe(false);
  });

  it("checks the scope switch, and only the Site master for Policy", () => {
    const off = effectiveMemory(SITE_SWITCHES_ON, {
      ...WORKSPACE_SWITCHES_ON,
      memoryEnabled: false,
    });
    expect(code(() => assertEnabled(off, "user"))).toBe("memory_disabled");
    expect(code(() => assertEnabled(off, "site"))).toBe("memory_disabled");
    expect(code(() => assertEnabled(off, "site", true))).toBeUndefined();
    const siteOff = effectiveMemory(
      { ...SITE_SWITCHES_ON, memoryEnabled: false },
      WORKSPACE_SWITCHES_ON,
    );
    expect(code(() => assertEnabled(siteOff, "site", true))).toBe("memory_disabled");
  });
});
