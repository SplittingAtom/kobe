import { describe, expect, it } from "vitest";
import { SKILL_LIMITS } from "./limits";
import { validateSkill, type SkillDraft } from "./validate";

const ok: SkillDraft = {
  name: "demo",
  description: "A demo",
  other: "",
  body: "# Demo",
  files: [{ key: 1, path: "notes/a.txt", text: "hi" }],
};

describe("validateSkill", () => {
  it("accepts a valid draft", () => {
    expect(validateSkill(ok, [])).toEqual({ ok: true, problems: 0 });
  });

  it("explains name and description problems", () => {
    const res = validateSkill({ ...ok, name: "Bad Name", description: " " }, []);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.name?.[0]).toMatch(/lowercase/);
      expect(res.errors.description?.[0]).toMatch(/required/);
    }
  });

  it("refuses unsafe, reserved and duplicate paths", () => {
    const files = [
      { key: 1, path: "../x.txt", text: "" },
      { key: 2, path: "skill.md", text: "" },
      { key: 3, path: "a/B.txt", text: "" },
      { key: 4, path: "a/b.txt", text: "" },
      { key: 5, path: "", text: "" },
    ];
    const res = validateSkill({ ...ok, files }, []);
    if (res.ok) throw new Error("expected errors");
    expect(res.errors.files?.[1]).toBeDefined();
    expect(res.errors.files?.[2]).toBeDefined();
    expect(res.errors.files?.[4]).toBeDefined();
    expect(res.errors.files?.[5]).toBeDefined();
  });

  it("flags a kept binary clashing with a text path", () => {
    const res = validateSkill(ok, [{ path: "NOTES/a.txt", bytes: new Uint8Array(1) }]);
    expect(res.ok).toBe(false);
  });

  it("enforces size and count caps with clear messages", () => {
    const body = "x".repeat(SKILL_LIMITS.maxSkillMdBytes + 1);
    const a = validateSkill({ ...ok, body }, []);
    if (a.ok) throw new Error("expected errors");
    expect(a.errors.body?.[0]).toMatch(/100 KiB/);
    const files = Array.from({ length: SKILL_LIMITS.maxFiles }, (_, i) => ({
      key: i,
      path: `f${i}.txt`,
      text: "",
    }));
    const b = validateSkill({ ...ok, files }, []);
    if (b.ok) throw new Error("expected errors");
    expect(b.errors.form?.[0]).toMatch(/200 files/);
  });

  it("rejects other frontmatter that is invalid YAML or repeats name", () => {
    expect(validateSkill({ ...ok, other: "a: [" }, []).ok).toBe(false);
    expect(validateSkill({ ...ok, other: "name: x" }, []).ok).toBe(false);
    expect(validateSkill({ ...ok, other: "license: MIT" }, []).ok).toBe(true);
  });
});
