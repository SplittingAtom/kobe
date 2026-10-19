// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVIEWER_HINT, SkillReviewersSection } from "./site/skill-reviewers-section";
import { answerConfirm, forbidNativeConfirm, renderSite, stubApi } from "./testing";

const user = (
  id: string,
  name: string,
  siteRole = "user",
  deactivatedAt: string | null = null,
) => ({
  id,
  name,
  email: `${id}@x.io`,
  siteRole,
  deactivatedAt,
  createdAt: "2026-10-01T10:00:00Z",
});
const USERS = {
  users: [
    user("u-ann", "Ann", "admin"),
    user("u-bob", "Bob"),
    user("u-cy", "Cy"),
    user("u-dee", "Dee", "user", "2026-10-02T10:00:00Z"),
  ],
};
const grant = (userId: string, name: string) => ({
  userId,
  name,
  email: `${userId}@x.io`,
  grant: "skill_reviewer",
  grantedBy: "u-ann",
  grantedAt: "2026-10-19T10:00:00Z",
});

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Skill reviewers (KOBE-331)", () => {
  it("says what reviewers may do, offers active users and other admins, and gives the grant", async () => {
    const calls = stubApi({
      "GET /v1/site/roles/grants": [
        [200, { grants: [grant("u-cy", "Cy")] }],
        [200, { grants: [grant("u-bob", "Bob"), grant("u-cy", "Cy")] }],
      ],
      "GET /v1/site/users": [200, USERS],
      "PUT /v1/site/roles/grants/u-bob/skill_reviewer": [200, { changed: true }],
    });
    renderSite(<SkillReviewersSection />, "admin");
    expect(screen.getByText(REVIEWER_HINT)).toBeTruthy();
    const form = await screen.findByRole("form", { name: "Give Skill reviewer" });
    expect(
      within(form)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Choose a user…", "Ann (u-ann@x.io)", "Bob (u-bob@x.io)"]);
    await userEvent.selectOptions(within(form).getByLabelText("Reviewer"), "u-bob");
    await userEvent.click(within(form).getByRole("button", { name: "Make Skill reviewer" }));
    await screen.findByText("Bob is now a Skill reviewer.");
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.url)).toEqual([
      "/v1/site/roles/grants/u-bob/skill_reviewer",
    ]);
  });

  it("asks before taking the grant", async () => {
    const calls = stubApi({
      "GET /v1/site/roles/grants": [
        [200, { grants: [grant("u-cy", "Cy")] }],
        [200, { grants: [] }],
      ],
      "GET /v1/site/users": [200, USERS],
      "DELETE /v1/site/roles/grants/u-cy/skill_reviewer": [204],
    });
    renderSite(<SkillReviewersSection />, "admin");
    await userEvent.click(
      await screen.findByRole("button", { name: "Take Skill reviewer from Cy" }),
    );
    await answerConfirm("Take Skill reviewer from Cy?", "Cancel");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Take Skill reviewer from Cy" }));
    await answerConfirm("Take Skill reviewer from Cy?", "Take Skill reviewer");
    await screen.findByText("Cy is no longer a Skill reviewer.");
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("offers oneself only on a single-admin Site and marks a self-grant (review-336)", async () => {
    stubApi({
      "GET /v1/site/roles/grants": [
        200,
        { grants: [{ ...grant("u-me", "Ada"), grantedBy: "u-me" }] },
      ],
      "GET /v1/site/users": [200, { users: [user("u-me", "Ada", "admin"), user("u-bob", "Bob")] }],
    });
    renderSite(<SkillReviewersSection />, "admin");
    expect(await screen.findByText("self-granted")).toBeTruthy();
    // Already holding it: only Bob is offered.
    const form = screen.getByRole("form", { name: "Give Skill reviewer" });
    expect(
      within(form)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Choose a user…", "Bob (u-bob@x.io)"]);
    cleanup();
    stubApi({
      "GET /v1/site/roles/grants": [200, { grants: [] }],
      "GET /v1/site/users": [
        200,
        { users: [user("u-me", "Ada", "admin"), user("u-ann", "Ann", "admin")] },
      ],
    });
    renderSite(<SkillReviewersSection />, "admin");
    const other = await screen.findByRole("form", { name: "Give Skill reviewer" });
    expect(
      within(other)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Choose a user…", "Ann (u-ann@x.io)"]);
  });
});
