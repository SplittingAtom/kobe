import { describe, expect, it } from "vitest";
import { draftContent, draftPathProblem, pathFromUrl, skeletonSkillMd } from "./files.js";
import { parseSkillMd } from "../skill-md.js";

describe("draft file paths (KOBE-320)", () => {
  it("decodes each URL segment on its own and refuses a decoded slash", () => {
    expect(pathFromUrl("references/notes%20one.md")).toBe("references/notes one.md");
    expect(pathFromUrl("caf%C3%A9.md")).toBe("café.md");
    expect(pathFromUrl("..%2Fescape")).toBeNull();
    expect(pathFromUrl("bad%E0%A4%A")).toBeNull();
  });

  it("applies the package contract's rules for authored content", () => {
    expect(draftPathProblem("scripts/run.py", ["SKILL.md"])).toBeNull();
    expect(draftPathProblem("evals/cases.yaml", ["SKILL.md"])).toBeNull();
    // A draft may lack SKILL.md while it is written.
    expect(draftPathProblem("references/a.md", [])).toBeNull();
    for (const path of ["provenance.json", "Evals/x", "skill.md", "evals", "../x", "a//b", "/abs"])
      expect(draftPathProblem(path, ["SKILL.md"]), path).not.toBeNull();
    expect(draftPathProblem("SKILL.md/x", ["SKILL.md"])).not.toBeNull();
    expect(draftPathProblem("Notes.md", ["notes.md"])).not.toBeNull();
    // Rewriting a file is not a clash with itself.
    expect(draftPathProblem("notes.md", ["notes.md"])).toBeNull();
  });

  it("keeps UTF-8 text inline and anything else as bytes", () => {
    expect(draftContent(new TextEncoder().encode("héllo"))).toEqual({ text: "héllo" });
    expect("bytes" in draftContent(new Uint8Array([0x68, 0x00]))).toBe(true);
    expect("bytes" in draftContent(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(true);
    // A BOM is kept as written (bytes round-trip exactly).
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
    const kept = draftContent(bom);
    expect("text" in kept && new TextEncoder().encode(kept.text)).toEqual(bom);
  });

  it("starts a blank draft with a SKILL.md that parses under its name", () => {
    const parsed = parseSkillMd(new TextEncoder().encode(skeletonSkillMd("my-skill")));
    expect(typeof parsed === "string" ? parsed : parsed.name).toBe("my-skill");
  });
});
