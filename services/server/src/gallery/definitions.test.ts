import { describe, expect, it } from "vitest";
import { agentSkills } from "@kobe/agent-file";
import { BUILTIN_SKILL_NAMES } from "@kobe/protocol";
import { RESEARCHER_NO_SEARCH_NOTICE } from "./agents/researcher.js";
import { GALLERY_DEFINITIONS, parseGalleryDefinitions } from "./definitions.js";

describe("the repo's gallery definitions", () => {
  it("all parse, with unique keys and positive generations", () => {
    expect(() => parseGalleryDefinitions(GALLERY_DEFINITIONS)).not.toThrow();
  });

  it("refuses a missing generation", () => {
    const file = "---\nname: X\n---\nx\n";
    expect(() => parseGalleryDefinitions([{ key: "x", generation: 0, file }])).toThrow(
      /generation/,
    );
  });
});

describe("the five gallery agents (KOBE-89)", () => {
  const parsed = parseGalleryDefinitions(GALLERY_DEFINITIONS);
  const byKey = new Map(parsed.map((p) => [p.key, p.definition]));
  const def = (key: string) => {
    const found = byKey.get(key);
    if (!found) throw new Error(`no gallery definition ${key}`);
    return found;
  };
  const skillsOf = (key: string) => agentSkills(def(key).frontmatter).names;

  it("ships exactly the five", () => {
    expect([...byKey.keys()].sort()).toEqual(
      ["assistant", "code-helper", "data-analyst", "document-drafter", "researcher"].sort(),
    );
    // The Assistant gained the skill-creator skill in generation 2.
    expect(Object.fromEntries(parsed.map((p) => [p.key, p.generation]))).toEqual({
      assistant: 2,
      "data-analyst": 1,
      researcher: 1,
      "document-drafter": 1,
      "code-helper": 1,
    });
  });

  it("pins no model and lists only built-in skills", () => {
    for (const { definition } of parsed) {
      expect(definition.frontmatter.model).toBeUndefined();
      expect(definition.prompt.length).toBeGreaterThan(200);
      expect(definition.frontmatter.description).toBeTruthy();
      for (const name of agentSkills(definition.frontmatter).names) {
        expect(BUILTIN_SKILL_NAMES).toContain(name);
      }
    }
  });

  it("gives each specialist its skills", () => {
    expect(skillsOf("data-analyst")).toEqual(["data-analysis", "charts", "xlsx"]);
    expect(skillsOf("document-drafter")).toEqual(["docx", "pdf"]);
    expect(skillsOf("code-helper")).toEqual(["code-review"]);
    expect(skillsOf("researcher")).toEqual(["pdf", "docx", "xlsx"]);
    expect(skillsOf("assistant")).toEqual(["skill-creator"]);
  });

  it("the Researcher tells the person plainly when it has no web search", () => {
    expect(def("researcher").prompt).toContain(RESEARCHER_NO_SEARCH_NOTICE);
  });

  it("the Document Drafter writes files and does not ask for artifact output", () => {
    const prompt = def("document-drafter").prompt;
    expect(prompt).not.toMatch(/artifact/i);
    expect(prompt).toMatch(/docx/);
  });
});
