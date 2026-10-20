import { describe, expect, it } from "vitest";
import { isWorkspacePath, panelOfPath } from "./panels";

/** KOBE-452: which addresses open which panel over the workspace. */
describe("panelOfPath (KOBE-452)", () => {
  it("names the consoles, My agents, Skills and the My area pages", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["/admin/team", "Team console"],
      ["/admin/team/members", "Team console"],
      ["/admin/team/agents/a-1/evals/e-1", "Team console"],
      ["/admin/site", "Site console"],
      ["/admin/site/audit", "Site console"],
      ["/admin", "Administration"],
      ["/me/agents", "My agents"],
      ["/me/agents/new", "My agents"],
      ["/me/skills", "Skills"],
      ["/me/skills/drafts/d-1", "Skills"],
      ["/me/memory", "My memory"],
      ["/me/approvals", "My approvals"],
      ["/me/schedules", "My schedules"],
      ["/me/connectors", "My connectors"],
      ["/me/projects/p-1", "Projects"],
      ["/me/shared-cases", "My shared cases"],
    ];
    for (const [path, title] of cases) expect(panelOfPath(path)?.title, path).toBe(title);
  });

  it("matches whole segments only, and nothing outside the consoles and the My area", () => {
    expect(panelOfPath("/administer")).toBeUndefined();
    expect(panelOfPath("/admin/teams")?.title).toBe("Administration");
    expect(panelOfPath("/me/skillset")?.title).toBe("My area");
    for (const path of ["/", "/sign-in", "/setup", "/invite", "/reset-password", ""]) {
      expect(panelOfPath(path), path).toBeUndefined();
    }
  });

  it("the single pages that had their own frame beside the thread leave their title to it", () => {
    for (const path of ["/me/memory", "/me/approvals", "/me/schedules", "/me/connectors"]) {
      expect(panelOfPath(path)?.embedded, path).toBe(true);
    }
    for (const path of ["/admin/team", "/me/agents", "/me/skills", "/me/projects"]) {
      expect(panelOfPath(path)?.embedded, path).toBe(false);
    }
  });

  it("the workspace is the chat and every panel address", () => {
    expect(isWorkspacePath("/")).toBe(true);
    expect(isWorkspacePath("/admin/team/usage")).toBe(true);
    expect(isWorkspacePath("/me/memory")).toBe(true);
    expect(isWorkspacePath("/sign-in")).toBe(false);
    expect(isWorkspacePath("/setup")).toBe(false);
  });
});
