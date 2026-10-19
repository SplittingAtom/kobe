// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillAdminPage } from "./team/skill-editor/skill-admin-page";
import { SkillsPage } from "./team/skill-editor/skills-page";
import { forbidNativeConfirm, renderTeam, stubApi, summary } from "./testing";

/**
 * KOBE-321 (ac-3): the Team console keeps admin views only; skills are written in the Workbench.
 */
beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SKILL = {
  id: "s-1",
  scope: "team",
  slug: "report-writer",
  description: "Writes reports.",
  latest_version: 2,
  latest_semver: "0.2.0",
  owner_user_id: "u-me",
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
};

describe("Team console skills (admin view)", () => {
  it("lists team skills with links to their admin view, and sends authors to the Workbench", async () => {
    const calls = stubApi({ "GET /v1/skills?scope=team": [200, { skills: [SKILL] }] });
    renderTeam(<SkillsPage />);
    const link = await screen.findByRole("link", { name: "report-writer" });
    expect(link.getAttribute("href")).toBe("/admin/team/skills/s-1");
    expect(screen.getByRole("link", { name: "Open the Workbench" }).getAttribute("href")).toBe(
      "/me/skills?tab=workbench",
    );
    expect(screen.queryByRole("link", { name: "New skill" })).toBeNull();
    expect(summary(calls)).toContain("GET /v1/skills?scope=team");
  });

  it("shows a skill's access and reach without an editor", async () => {
    stubApi({
      "GET /v1/skills/s-1": [200, { skill: SKILL }],
      "GET /v1/skills/s-1/reach": [
        200,
        { offer_to_all: false, access: "available", approved: true, agents: [] },
      ],
      "GET /v1/skills/s-1/usage": [200, { uses: 0, last_used_at: null, agents: [] }],
      "GET /v1/skill-evals?scope=team&skill_id=s-1": [200, { evals: [] }],
    });
    renderTeam(<SkillAdminPage skillId="s-1" />);
    expect(await screen.findByRole("heading", { level: 1, name: "report-writer" })).toBeDefined();
    expect(screen.getByText(/Latest version: v0\.2\.0/)).toBeDefined();
    expect(screen.getByRole("link", { name: "All skills" }).getAttribute("href")).toBe(
      "/admin/team/skills",
    );
    expect(screen.queryByLabelText(/Instructions/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
  });
});
