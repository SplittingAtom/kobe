import { describe, expect, it } from "vitest";
import { formatRestrictedProjects, type RestrictedProjectsReport } from "./restricted-projects.js";

const project = {
  teamId: "11111111-1111-4111-8111-111111111111",
  teamSlug: "research",
  teamName: "Research",
  projectId: "22222222-2222-4222-8222-222222222222",
  projectSlug: "merger",
  projectName: "Merger",
  archived: false,
  members: [
    {
      userId: "33333333-3333-4333-8333-333333333333",
      email: "o@x.test",
      name: "Olive",
      role: "owner",
    },
    {
      userId: "44444444-4444-4444-8444-444444444444",
      email: "r@x.test",
      name: "Ray",
      role: "reader",
    },
  ],
};

describe("formatRestrictedProjects", () => {
  it("lists each restricted project with its members and roles, and what the migration does", () => {
    const report: RestrictedProjectsReport = { state: "pending", projects: [project] };
    const text = formatRestrictedProjects(report);
    expect(text).toContain("1 restricted project");
    expect(text).toContain("research (Research) / merger: Merger");
    expect(text).toContain("owner   o@x.test (Olive)");
    expect(text).toContain("reader  r@x.test (Ray)  [row deleted]");
    expect(text).toMatch(/every member of its workspace/);
  });

  it("marks archived projects and projects without explicit members", () => {
    const text = formatRestrictedProjects({
      state: "pending",
      projects: [{ ...project, archived: true, members: [] }],
    });
    expect(text).toContain("merger: Merger (archived)");
    expect(text).toContain("(no explicit members)");
  });

  it("says when there is nothing to show, and when the migration already ran", () => {
    expect(formatRestrictedProjects({ state: "pending", projects: [] })).toMatch(
      /No restricted projects/,
    );
    expect(formatRestrictedProjects({ state: "migrated", projects: [] })).toMatch(
      /already ran the migration/,
    );
  });
});
