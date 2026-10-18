// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillRescansSection } from "./site/skill-rescans-section";
import { renderSite, stubApi } from "./testing";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Skill rescans in the Site console (KOBE-313, ac-3)", () => {
  it("shows each rescan's progress and the versions it suspended", async () => {
    stubApi({
      "GET /v1/site/skill-rescans": [
        200,
        {
          current: "2026.10.18.3",
          rescans: [
            {
              ruleSet: 4,
              ruleSetVersion: "2026.10.18.3",
              status: "done",
              startedAt: "2026-10-18T10:00:00.000Z",
              finishedAt: "2026-10-18T10:01:00.000Z",
              scanned: 42,
              changed: 3,
              suspended: 2,
              failed: 0,
              suspensions: [
                { scope: "team", teamId: "t-1", skillId: "s-1", version: 2, slug: "hidden-elf" },
                { scope: "personal", skillId: "s-2", version: 1, slug: "my-helper" },
              ],
            },
          ],
        },
      ],
    });
    renderSite(<SkillRescansSection />);
    const table = await screen.findByRole("table", { name: "Skill rescans" });
    const row = within(table).getAllByRole("row")[1] as HTMLElement;
    expect(within(row).getByText("Done")).toBeTruthy();
    expect(within(row).getByText("42")).toBeTruthy();
    expect(within(row).getByText("hidden-elf (version 2, team skill)")).toBeTruthy();
    expect(within(row).getByText("my-helper (version 1, personal skill)")).toBeTruthy();
  });

  it("says when nothing was rescanned yet", async () => {
    stubApi({ "GET /v1/site/skill-rescans": [200, { current: "2026.10.18.3", rescans: [] }] });
    renderSite(<SkillRescansSection />);
    expect(await screen.findByText("No rescans yet.")).toBeTruthy();
  });
});
