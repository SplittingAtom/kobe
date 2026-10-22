import { describe, expect, it } from "vitest";
import { loadSkillMirrorConfig } from "./config.js";

describe("loadSkillMirrorConfig (KOBE-343)", () => {
  it("has no credentials without the token, and defaults the identity", () => {
    expect(loadSkillMirrorConfig({})).toEqual({
      credentials: null,
      author: { name: "Kobe Registry", email: "registry@kobe.invalid" },
    });
  });

  it("reads the token and user name, and refuses malformed values without echoing the token", () => {
    expect(
      loadSkillMirrorConfig({
        KOBE_SKILL_MIRROR_TOKEN: "ghp_abcdefgh",
        KOBE_SKILL_MIRROR_USERNAME: "kobe",
      }).credentials,
    ).toEqual({ username: "kobe", token: "ghp_abcdefgh" });
    let message = "";
    try {
      loadSkillMirrorConfig({ KOBE_SKILL_MIRROR_TOKEN: "bad token:x" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/KOBE_SKILL_MIRROR_TOKEN/);
    expect(message).not.toContain("bad token:x");
    expect(() => loadSkillMirrorConfig({ KOBE_SKILL_MIRROR_USERNAME: "a b" })).toThrow();
  });
});
