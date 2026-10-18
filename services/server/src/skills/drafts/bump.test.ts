import { describe, expect, it } from "vitest";
import { adviseBump, bumpSemver } from "./bump.js";

const enc = (s: string) => new TextEncoder().encode(s);
const md = (name: string, description: string, body: string, extra = "") =>
  enc(`---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`);
const files = (entries: Record<string, Uint8Array | string>) =>
  new Map(
    Object.entries(entries).map(([p, v]) => [p, typeof v === "string" ? enc(v) : v] as const),
  );

const BASE = {
  "SKILL.md": md("notes", "Writes notes. Use when asked for notes.", "Be brief."),
  "references/guide.md": "Guide.",
  "scripts/run.py": "print(1)",
  "assets/logo.png": new Uint8Array([0x89, 0x50]),
};

/** SK14: patch for references or assets, minor for the body, major for name, description or scripts. */
describe("adviseBump (KOBE-321, SK14)", () => {
  it("says nothing changed for the same files", () => {
    expect(adviseBump(files(BASE), files(BASE))).toEqual({ kind: null, reasons: [] });
  });

  it("suggests a patch for references, assets, evals and kobe.skill.yaml", () => {
    for (const change of [
      { "references/guide.md": "Guide, revised." },
      { "assets/logo.png": new Uint8Array([0x89, 0x51]) },
      { "references/new.md": "New." },
      { "evals/cases.yaml": "cases: []" },
      { "kobe.skill.yaml": "apiVersion: kobe.dev/skill/v1" },
    ]) {
      const advice = adviseBump(files(BASE), files({ ...BASE, ...change }));
      expect(advice.kind, JSON.stringify(Object.keys(change))).toBe("patch");
      expect(advice.reasons.length).toBe(1);
    }
    const removed: Record<string, Uint8Array | string> = { ...BASE };
    delete removed["references/guide.md"];
    expect(adviseBump(files(BASE), files(removed)).kind).toBe("patch");
  });

  it("suggests a minor for a SKILL.md body or other frontmatter edit", () => {
    const body = md("notes", "Writes notes. Use when asked for notes.", "Be very brief.");
    expect(adviseBump(files(BASE), files({ ...BASE, "SKILL.md": body }))).toEqual({
      kind: "minor",
      reasons: ["SKILL.md instructions changed"],
    });
    const extra = md(
      "notes",
      "Writes notes. Use when asked for notes.",
      "Be brief.",
      "license: MIT\n",
    );
    expect(adviseBump(files(BASE), files({ ...BASE, "SKILL.md": extra })).kind).toBe("minor");
  });

  it("suggests a major for the name, the description or any script", () => {
    const renamed = md("notes-two", "Writes notes. Use when asked for notes.", "Be brief.");
    expect(adviseBump(files(BASE), files({ ...BASE, "SKILL.md": renamed }))).toEqual({
      kind: "major",
      reasons: ["the name changed"],
    });
    const described = md("notes", "Writes short notes. Use when asked.", "Be brief.");
    expect(adviseBump(files(BASE), files({ ...BASE, "SKILL.md": described })).reasons).toEqual([
      "the description changed",
    ]);
    const script = adviseBump(files(BASE), files({ ...BASE, "scripts/run.py": "print(2)" }));
    expect(script).toEqual({ kind: "major", reasons: ["scripts changed: scripts/run.py"] });
    // A script outside scripts/ counts too.
    expect(adviseBump(files(BASE), files({ ...BASE, "tools/x.sh": "echo" })).kind).toBe("major");
  });

  it("takes the largest kind and lists every reason", () => {
    const advice = adviseBump(
      files(BASE),
      files({
        ...BASE,
        "SKILL.md": md("notes", "Writes notes. Use when asked for notes.", "Other."),
        "references/guide.md": "Changed.",
        "scripts/run.py": "print(3)",
      }),
    );
    expect(advice.kind).toBe("major");
    expect(advice.reasons).toEqual([
      "scripts changed: scripts/run.py",
      "SKILL.md instructions changed",
      "other files changed: references/guide.md",
    ]);
  });

  it("treats an unreadable SKILL.md as a description change (major)", () => {
    expect(adviseBump(files(BASE), files({ ...BASE, "SKILL.md": "no frontmatter" })).kind).toBe(
      "major",
    );
  });
});

describe("bumpSemver", () => {
  it("raises the right part and resets the lower ones", () => {
    expect(bumpSemver("1.4.2", "patch")).toBe("1.4.3");
    expect(bumpSemver("1.4.2", "minor")).toBe("1.5.0");
    expect(bumpSemver("1.4.2", "major")).toBe("2.0.0");
    expect(bumpSemver("0.3.0", "major")).toBe("1.0.0");
  });

  it("gives null past the nine-digit range or for a malformed number", () => {
    expect(bumpSemver("999999999.0.0", "major")).toBeNull();
    expect(bumpSemver("1.2", "patch")).toBeNull();
  });
});
