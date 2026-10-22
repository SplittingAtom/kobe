import { describe, expect, it } from "vitest";
import {
  EMPTY_FORM,
  firstTabWithError,
  fromFrontmatter,
  replacedConnectorNames,
  splitLines,
  toFrontmatter,
  validateForm,
} from "./form-model";

const form = (over: Partial<typeof EMPTY_FORM>) => ({ ...EMPTY_FORM, name: "Triage", ...over });

describe("agent builder form model", () => {
  it("leaves blank fields out of the frontmatter", () => {
    expect(toFrontmatter(form({ role: "  " }))).toEqual({ name: "Triage" });
  });

  it("writes lists, exclusive skills, tools and approval mode in the file's shape", () => {
    const fm = toFrontmatter(
      form({
        skills: "sql\n\n charts ",
        skillsExclusive: true,
        toolsAllow: "bash",
        approvalMode: "ask-all",
        starters: "Hi",
      }),
    );
    expect(fm).toEqual({
      name: "Triage",
      skills: { exclusive: ["sql", "charts"] },
      tools: { allow: ["bash"] },
      approval_mode: "ask-all",
      starters: ["Hi"],
    });
  });

  it("round-trips a stored frontmatter through the form", () => {
    const stored = {
      name: "Triage",
      role: "Support",
      skills: { exclusive: ["sql"] },
      connectors: ["github"],
      tools: { allow: ["read*"], deny: ["bash"] },
      approval_mode: "auto",
    };
    expect(toFrontmatter(fromFrontmatter(stored))).toEqual(stored);
  });

  it("writes and reads `connectors: all` (every team connector, KOBE-254)", () => {
    expect(toFrontmatter(form({ connectorsAll: true, connectors: "ignored" }))).toEqual({
      name: "Triage",
      connectors: "all",
    });
    const stored = { name: "Triage", connectors: "all" };
    expect(fromFrontmatter(stored)).toMatchObject({ connectorsAll: true, connectors: "" });
    expect(toFrontmatter(fromFrontmatter(stored))).toEqual(stored);
    expect(fromFrontmatter({ name: "T", connectors: ["all"] })).toMatchObject({
      connectorsAll: false,
      connectors: "all",
    });
    expect(validateForm(form({ connectorsAll: true }), "").ok).toBe(true);
  });

  it("warns, never silently, that ticking every connector replaces typed names", () => {
    const ticked = form({ connectorsAll: true, connectors: "jira\ngithub" });
    expect(replacedConnectorNames(ticked)).toEqual(["jira", "github"]);
    const result = validateForm(ticked, "");
    expect(result.ok && result.warnings).toEqual([
      "every team connector replaces the 2 connector names listed (jira, github); they are not saved",
    ]);
    expect(replacedConnectorNames(form({ connectors: "jira" }))).toEqual([]);
    expect(replacedConnectorNames(form({ connectorsAll: true }))).toEqual([]);
  });

  it("validates with the agent-file schema and reports per field", () => {
    const result = validateForm(form({ name: "", skills: "ok\nNot A Slug" }), "");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.name?.[0]).toMatch(/empty/);
    expect(result.errors.skills?.[0]).toMatch(/^Entry 2 /);
  });

  it("accepts a valid definition and warns about auto approval", () => {
    const result = validateForm(form({ approvalMode: "auto" }), "Help people.\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.prompt).toBe("Help people.");
    expect(result.warnings).toHaveLength(1);
  });

  it("splits lines without blanks", () => {
    expect(splitLines("a\n\n b \n")).toEqual(["a", "b"]);
  });
});

describe("Dangerous mode and tabs (KOBE-476)", () => {
  it("keeps a stored Dangerous mode through the form (never dropped on open)", () => {
    const f = fromFrontmatter({ name: "Ops", approval_mode: "dangerous" });
    expect(f.approvalMode).toBe("dangerous");
    expect(toFrontmatter(f)).toEqual({ name: "Ops", approval_mode: "dangerous" });
  });

  it("names the first tab holding an error", () => {
    expect(firstTabWithError({})).toBeNull();
    expect(firstTabWithError({ starters: ["x"] })).toBe("behaviour");
    expect(firstTabWithError({ prompt: ["x"], starters: ["y"] })).toBe("identity");
    expect(firstTabWithError({ slug: ["x"] })).toBe("identity");
    expect(firstTabWithError({ toolsDeny: ["x"] })).toBe("behaviour");
  });
});
