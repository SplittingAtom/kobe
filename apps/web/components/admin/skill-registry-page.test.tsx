// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOT_READY, REGISTRY_TEAM_HINT, SkillRegistryPage } from "./site/skill-registry-page";
import { renderSite, stubApi } from "./testing";

const PATH = "/v1/site/skills/registry/settings";
const TEAM_PATH = "/v1/site/skills/registry/team";
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
  it("says the Registry is not ready until its team is created, and shows the spec's defaults", async () => {
    stubApi({ [`GET ${PATH}`]: [200, settings()] });
    renderSite(<SkillRegistryPage />);
    expect(await screen.findByText(NOT_READY)).toBeTruthy();
    expect(screen.getByText(REGISTRY_TEAM_HINT)).toBeTruthy();
    // No existing team can be picked (review H1).
    expect(screen.queryByLabelText("Registry team")).toBeNull();
    expect((screen.getByLabelText("Eval cases, at least") as HTMLInputElement).value).toBe("3");
    expect(
      (screen.getByLabelText("Pass rate with the skill, at least (0 to 1)") as HTMLInputElement)
        .value,
    ).toBe("0.8");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("creates the dedicated Registry team", async () => {
    const calls = stubApi({
      [`GET ${PATH}`]: [
        [200, settings()],
        [200, settings({ ready: true, registryTeam: TEAM, updatedAt: "2026-10-19T11:00:00.000Z" })],
      ],
      [`POST ${TEAM_PATH}`]: [201, settings({ ready: true, registryTeam: TEAM })],
    });
    renderSite(<SkillRegistryPage />);
    await screen.findByText(NOT_READY);
    await userEvent.click(screen.getByRole("button", { name: "Create the Registry team" }));
    expect(await screen.findByText(/Ready\. Site-side runs use the team Registry\./)).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({
      name: "Skill Registry",
      slug: "skill-registry",
    });
  });

  it("sends only what changed", async () => {
    const calls = stubApi({
      [`GET ${PATH}`]: [
        [200, settings({ ready: true, registryTeam: TEAM })],
        [200, settings({ ready: true, registryTeam: TEAM, updatedAt: "2026-10-19T11:00:00.000Z" })],
      ],
      [`PUT ${PATH}`]: [200, settings({ ready: true, registryTeam: TEAM })],
    });
    renderSite(<SkillRegistryPage />);
    const precision = await screen.findByLabelText("Trigger precision, at least (0 to 1)");
    await userEvent.clear(precision);
    await userEvent.type(precision, "0.9");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Registry settings saved.");
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(String(put?.body))).toEqual({
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
