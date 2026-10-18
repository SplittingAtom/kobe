// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { must } from "../../lib/testing/must";
import { CatalogSwitchesSection } from "./team/skill-editor/catalog-switches";
import { MySkillChoices } from "./team/skill-editor/my-skill-choices";
import { renderTeam, stubApi } from "./testing";

afterEach(cleanup);

/**
 * KOBE-316: a member turns their personal skills on or off in this team (ac-1) and the team's
 * Available and On by default skills for themselves (ac-3); Required ones are locked on. Team
 * admins change the catalog switches; others see them disabled.
 */
const CHOICES = {
  personal: [{ skill_id: "p-1", name: "my-notes", enabled: true }],
  team: [
    { skill_id: "t-1", name: "house-style", access: "required", enabled: true },
    { skill_id: "t-2", name: "charts", access: "default_on", enabled: true },
  ],
  catalog: [{ skill_id: "c-1", name: "xlsx", access: "available", enabled: false }],
};

describe("My skill choices", () => {
  it("turns a personal skill off in this team; Required is locked on", async () => {
    const calls = stubApi({
      "GET /v1/me/skills/enablements": [200, CHOICES],
      "PUT /v1/me/skills/enablements": [200, { enabled: false }],
    });
    renderTeam(<MySkillChoices />, { role: "member", permissions: ["team.read"] });
    const mine = (await screen.findByRole("checkbox", { name: /my-notes/ })) as HTMLInputElement;
    expect(mine.checked).toBe(true);
    const required = screen.getByRole("checkbox", { name: /house-style/ }) as HTMLInputElement;
    expect([required.checked, required.disabled]).toEqual([true, true]);
    const xlsx = screen.getByRole("checkbox", { name: /xlsx/ }) as HTMLInputElement;
    expect([xlsx.checked, xlsx.disabled]).toEqual([false, false]);
    await userEvent.click(mine);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(put.body as string)).toEqual({
      kind: "personal",
      skillId: "p-1",
      enabled: false,
    });
  });
});

describe("Catalog settings", () => {
  const SETTINGS = {
    personal_skills_disabled: false,
    members_may_add_catalog: true,
    builders_may_install_catalog: true,
  };

  it("a team admin turns Builder installs off", async () => {
    const calls = stubApi({
      "GET /v1/team/skill-review/settings": [200, SETTINGS],
      "PUT /v1/team/skill-review/settings": [
        200,
        { ...SETTINGS, builders_may_install_catalog: false },
      ],
    });
    renderTeam(<CatalogSwitchesSection />, { permissions: ["team.skills.review"] });
    const builders = (await screen.findByRole("checkbox", {
      name: /Builders may install catalog skills/,
    })) as HTMLInputElement;
    await userEvent.click(builders);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(put.body as string)).toEqual({ buildersMayInstallCatalog: false });
  });

  it("others see the switches but can't change them", async () => {
    stubApi({ "GET /v1/team/skill-review/settings": [200, SETTINGS] });
    renderTeam(<CatalogSwitchesSection />, {
      role: "builder",
      permissions: ["team.skills.publish"],
    });
    const adds = (await screen.findByRole("checkbox", {
      name: /Members may add catalog skills/,
    })) as HTMLInputElement;
    expect(adds.disabled).toBe(true);
    expect(screen.getByText("Only team admins can change these.")).toBeTruthy();
  });
});
