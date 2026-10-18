import { canonicalZip } from "@kobe/protocol";
import { scanSkillBundle } from "@kobe/skill-scanner";
import { describe, expect, it } from "vitest";
import { validateZipBundle } from "../bundle.js";
import { TEMPLATE_IDS, templateFiles, templates } from "./templates.js";

/** KOBE-322 (SK10 start 1): five templates, each a valid package that scans Pass. */
describe("Workbench templates", () => {
  it("offers the five kinds the spec names", () => {
    expect(templates().map((t) => t.title)).toEqual([
      "Document generator",
      "Data analysis",
      "API helper",
      "Review checklist",
      "House style",
    ]);
  });

  it.each(TEMPLATE_IDS)(
    "%s passes upload validation under the author's name and scans Pass",
    (id) => {
      const files = templateFiles(id, "my-skill");
      const valid = validateZipBundle(canonicalZip(files));
      expect(valid.ok, JSON.stringify(valid)).toBe(true);
      if (valid.ok) expect(valid.value.name).toBe("my-skill");
      const scan = scanSkillBundle([...files].map(([path, bytes]) => ({ path, bytes })));
      expect(scan.findings, id).toEqual([]);
      // Every file the body links to is in the template.
      const body = new TextDecoder().decode(files.get("SKILL.md"));
      for (const [, target] of body.matchAll(/\]\(([^)]+)\)/g))
        expect(files.has(target ?? "")).toBe(true);
    },
  );
});
