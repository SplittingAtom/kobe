// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromotePanel } from "../skills/promote-panel";
import { PromotionRequestsSection } from "./team/skill-editor/promotion-requests-section";
import { TEAM, renderTeam, stubApi } from "./testing";

/** KOBE-333 (SK19, SK20): Promote to Site in the Skills page and the team's request queue. */
const ADMIN = ["team.skills.review", "team.skills.publish"];
const SOURCE = { scope: "team" as const, skillId: "s-1", version: 2 };
const PREVIEW_PATH = "/v1/skills/promotions/preview?scope=team&skillId=s-1&version=2";
const preview = (refusals: { code: string; message: string }[] = []) => ({
  name: "sales-report",
  semver: "1.1.0",
  packageHash: "a".repeat(64),
  files: [{ path: "SKILL.md", size: 120 }],
  fixtures: [{ path: "evals/cases.yaml", size: 300 }],
  fromConversation: true,
  newSkill: false,
  scorecard: null,
  verdict: "pass",
  refusals,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Promote to Site (KOBE-333)", () => {
  it("shows what leaves the team and the rules' reasons; nothing can be sent while refused", async () => {
    stubApi({
      [`GET ${PREVIEW_PATH}`]: [
        200,
        preview([
          { code: "no_scorecard", message: "Run the full evals of this version first." },
          { code: "license", message: "kobe.skill.yaml needs a license." },
        ]),
      ],
    });
    renderTeam(<PromotePanel teamId={TEAM.id} source={SOURCE} onDone={() => {}} />);
    const panel = await screen.findByRole("group", { name: "Promote to Site" });
    await within(panel).findByText("evals/cases.yaml (300 B)");
    expect(within(panel).getByText(/Started from a conversation/)).toBeTruthy();
    const alert = within(panel).getByRole("alert");
    expect(alert.textContent).toContain("Run the full evals of this version first.");
    expect(alert.textContent).toContain("kobe.skill.yaml needs a license.");
    expect(within(panel).getByRole("button", { name: "Promote" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("promotes, or says it waits for a Team admin", async () => {
    const calls = stubApi({
      [`GET ${PREVIEW_PATH}`]: [200, preview()],
      ["POST /v1/skills/promotions"]: [202, { state: "requested", requestId: "r-1" }],
    });
    renderTeam(<PromotePanel teamId={TEAM.id} source={SOURCE} onDone={() => {}} />, {
      role: "builder",
    });
    await userEvent.click(await screen.findByRole("button", { name: "Promote" }));
    expect(await screen.findByText(/Sent to your Team admins/)).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual(SOURCE);
  });
});

describe("Create kobe.skill.yaml (KOBE-564)", () => {
  const MODELS = {
    models: [
      { alias: "k2", label: "Kimi K2", enabled: true, isDefault: true },
      { alias: "glm", label: "GLM Flash", enabled: true, isDefault: false },
      { alias: "off", label: "Disabled", enabled: false, isDefault: false },
    ],
    default: "k2",
  };
  const NO_MANIFEST = { code: "no_manifest", message: "The package needs a kobe.skill.yaml." };

  it("is offered only when the Site refuses for a missing manifest", async () => {
    stubApi({
      [`GET ${PREVIEW_PATH}`]: [200, preview([{ code: "license", message: "needs a license" }])],
      ["GET /v1/team/models"]: [200, MODELS],
    });
    renderTeam(<PromotePanel teamId={TEAM.id} source={SOURCE} onDone={() => {}} />);
    await screen.findByRole("group", { name: "Promote to Site" });
    expect(screen.queryByRole("group", { name: "Create kobe.skill.yaml" })).toBeNull();
  });

  it("offers the team's enabled models with the default preselected and the author's license, then opens the draft", async () => {
    const calls = stubApi({
      [`GET ${PREVIEW_PATH}`]: [200, preview([NO_MANIFEST])],
      ["GET /v1/team/models"]: [200, MODELS],
      ["POST /v1/skills/promotions/manifest"]: [
        201,
        {
          draft: { id: "d-9", name: "sales-report", rev: 1 },
          manifest: { summary: "Sales reports." },
          model: "glm",
          source: "model",
        },
      ],
    });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    renderTeam(<PromotePanel teamId={TEAM.id} source={SOURCE} onDone={() => {}} />);
    const group = await screen.findByRole("group", { name: "Create kobe.skill.yaml" });
    const model = (await within(group).findByRole("combobox", {
      name: "Model for the manifest",
    })) as HTMLSelectElement;
    expect(model.options[0]?.textContent).toBe("Team default (Kimi K2)");
    expect([...model.options].map((o) => o.textContent)).toEqual([
      "Team default (Kimi K2)",
      "GLM Flash",
    ]);
    const license = within(group).getByRole("combobox", { name: "License" }) as HTMLSelectElement;
    expect(license.value).toBe("Proprietary");
    await userEvent.selectOptions(model, "glm");
    await userEvent.selectOptions(license, "Apache-2.0");
    await userEvent.click(within(group).getByRole("button", { name: "Create kobe.skill.yaml" }));
    expect(await screen.findByText(/written by glm/)).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({
      ...SOURCE,
      model: "glm",
      license: "Apache-2.0",
    });
    expect(assign).toHaveBeenCalledWith("/me/skills/drafts/d-9");
    // The version itself still can't be promoted.
    expect(screen.getByRole("button", { name: "Promote" }).hasAttribute("disabled")).toBe(true);
  });

  it("sends no model for the team default and shows the server's refusal", async () => {
    const calls = stubApi({
      [`GET ${PREVIEW_PATH}`]: [200, preview([NO_MANIFEST])],
      ["GET /v1/team/models"]: [200, MODELS],
      ["POST /v1/skills/promotions/manifest"]: [
        502,
        { code: "call_failed", message: "The model k2 did not answer (budget exhausted)." },
      ],
    });
    renderTeam(<PromotePanel teamId={TEAM.id} source={SOURCE} onDone={() => {}} />);
    const group = await screen.findByRole("group", { name: "Create kobe.skill.yaml" });
    await within(group).findByRole("combobox", { name: "Model for the manifest" });
    await userEvent.click(within(group).getByRole("button", { name: "Create kobe.skill.yaml" }));
    expect(await screen.findByText(/did not answer/)).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({ ...SOURCE, license: "Proprietary" });
  });
});

describe("the team's Promote to Site requests (KOBE-333)", () => {
  const REQUEST = {
    id: "r-1",
    skillId: "s-1",
    version: 2,
    semver: "1.1.0",
    requestedBy: "u-bob",
    createdAt: "2026-10-19T10:00:00Z",
  };

  it("lets a Team admin see what leaves and confirm", async () => {
    const calls = stubApi({
      ["GET /v1/team/skill-promotions"]: [
        [200, { requests: [REQUEST] }],
        [200, { requests: [] }],
      ],
      ["GET /v1/team/skill-promotions/r-1"]: [200, { request: REQUEST, ...preview() }],
      ["POST /v1/team/skill-promotions/r-1/confirm"]: [
        201,
        { state: "submitted", registryVersionId: "v-1" },
      ],
    });
    renderTeam(<PromotionRequestsSection />, { permissions: ADMIN });
    await userEvent.click(await screen.findByRole("button", { name: "Version 1.1.0" }));
    const detail = await screen.findByRole("group", { name: "Request 1.1.0" });
    await within(detail).findByText("SKILL.md (120 B)");
    await userEvent.click(within(detail).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("No Builder waits for a promotion.")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/confirm"))).toBe(true);
  });

  it("declines with a note, and is hidden from Builders", async () => {
    const calls = stubApi({
      ["GET /v1/team/skill-promotions"]: [
        [200, { requests: [REQUEST] }],
        [200, { requests: [] }],
      ],
      ["GET /v1/team/skill-promotions/r-1"]: [200, { request: REQUEST, ...preview() }],
      ["POST /v1/team/skill-promotions/r-1/decline"]: [200, { state: "declined" }],
    });
    const { unmount } = renderTeam(<PromotionRequestsSection />, { permissions: ADMIN });
    await userEvent.click(await screen.findByRole("button", { name: "Version 1.1.0" }));
    const detail = await screen.findByRole("group", { name: "Request 1.1.0" });
    await userEvent.type(
      await within(detail).findByLabelText("Note to the Builder (optional)"),
      "Not yet",
    );
    await userEvent.click(within(detail).getByRole("button", { name: "Decline" }));
    await screen.findByText("No Builder waits for a promotion.");
    const post = calls.find((c) => c.url.endsWith("/decline"));
    expect(JSON.parse(String(post?.body))).toEqual({ note: "Not yet" });
    unmount();
    renderTeam(<PromotionRequestsSection />, { role: "builder", permissions: ["team.read"] });
    expect(screen.queryByText("Promote to Site requests")).toBeNull();
  });
});
