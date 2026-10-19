// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOT_READY, SkillRegistryPage } from "./site/skill-registry-page";
import { renderSite, stubApi } from "./testing";

const PATH = "/v1/site/skills/registry/settings";
const TEAM = { id: "t-1", slug: "registry", name: "Registry" };
const settings = (over: Record<string, unknown> = {}) => ({
  ready: false,
  registryTeam: null,
  judgeAlias: null,
  submissionRules: {
    minCases: 3,
    minNegativeCases: 1,
    minPassRate: 0.8,
    minLift: 0,
    minTriggerPrecision: 0.8,
    refuseBlockVerdict: true,
    requireLicense: true,
    requireFreshScorecard: true,
    retriesPerFailingCase: 1,
  },
  evalLimits: { maxConcurrentSandboxes: 4, maxCases: 25, caseWallClockMinutes: 10 },
  importAllowlist: [],
  scanner: { external: false },
  mirror: { enabled: false },
  updatedAt: "2026-10-19T10:00:00.000Z",
  ...over,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Skill Registry settings (KOBE-330)", () => {
  it("says the Registry is not ready until a team is named, and shows the spec's defaults", async () => {
    stubApi({
      [`GET ${PATH}`]: [200, settings()],
      ["GET /v1/site/teams"]: [200, { teams: [TEAM] }],
    });
    renderSite(<SkillRegistryPage />);
    expect(await screen.findByText(NOT_READY)).toBeTruthy();
    expect((screen.getByLabelText("Eval cases, at least") as HTMLInputElement).value).toBe("3");
    expect(
      (screen.getByLabelText("Pass rate with the skill, at least (0 to 1)") as HTMLInputElement)
        .value,
    ).toBe("0.8");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("sends only what changed and shows the Registry ready", async () => {
    const calls = stubApi({
      [`GET ${PATH}`]: [
        [200, settings()],
        [200, settings({ ready: true, registryTeam: TEAM, updatedAt: "2026-10-19T11:00:00.000Z" })],
      ],
      ["GET /v1/site/teams"]: [200, { teams: [TEAM] }],
      [`PUT ${PATH}`]: [200, settings({ ready: true, registryTeam: TEAM })],
    });
    renderSite(<SkillRegistryPage />);
    await screen.findByText(NOT_READY);
    await userEvent.selectOptions(screen.getByLabelText("Registry team"), "t-1");
    const precision = screen.getByLabelText("Trigger precision, at least (0 to 1)");
    await userEvent.clear(precision);
    await userEvent.type(precision, "0.9");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Ready\. Site-side runs use the team Registry\./)).toBeTruthy();
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(String(put?.body))).toEqual({
      registryTeamId: "t-1",
      submissionRules: {
        minCases: 3,
        minNegativeCases: 1,
        minPassRate: 0.8,
        minLift: 0,
        minTriggerPrecision: 0.9,
        retriesPerFailingCase: 1,
        refuseBlockVerdict: true,
        requireLicense: true,
        requireFreshScorecard: true,
      },
    });
  });
});
