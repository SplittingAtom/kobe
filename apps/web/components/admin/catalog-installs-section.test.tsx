// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogInstallsSection } from "./team/skill-editor/catalog-installs-section";
import { answerConfirm, renderTeam, stubApi, summary } from "./testing";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const INSTALLS = {
  installs: [
    {
      skillId: "s-1",
      name: "xlsx-pro",
      versionId: "v-1",
      semver: "1.1.0",
      pinMode: "within_major",
      access: "default_on",
      origin: "default_tag",
      installedBy: "u-1",
      updatedAt: "2026-10-18T10:00:00.000Z",
      isDefault: true,
    },
  ],
  removedDefaults: [
    {
      skillId: "s-2",
      name: "charts",
      optedOutBy: "u-1",
      reason: "We use our own.",
      at: "2026-10-18T10:00:00.000Z",
    },
  ],
};

describe("Catalog installs in the team console (KOBE-314, SK7)", () => {
  it("shows installs with the Site default badge and the Removed defaults", async () => {
    stubApi({ "GET /v1/team/skills/installs": [200, INSTALLS] });
    renderTeam(<CatalogInstallsSection />, { permissions: [] });
    const table = await screen.findByRole("table", { name: "Catalog installs" });
    expect(within(table).getByText("Added by Site default")).toBeTruthy();
    expect(within(table).getByText("On by default")).toBeTruthy();
    const removed = screen.getByRole("table", { name: "Removed defaults" });
    expect(within(removed).getByText("We use our own.")).toBeTruthy();
    // Without the permission there is nothing to press.
    expect(screen.queryByRole("button", { name: /Uninstall|Reinstall/ })).toBeNull();
  });

  it("lets a Team admin uninstall a default (opt-out) and reinstall one", async () => {
    const calls = stubApi({
      "GET /v1/team/skills/installs": [200, INSTALLS],
      "DELETE /v1/team/skills/installs/s-1": [200, { optedOut: true }],
      "POST /v1/team/skills/removed-defaults/s-2/reinstall": [201, { semver: "1.0.0" }],
    });
    renderTeam(<CatalogInstallsSection />, { permissions: ["team.skills.installs.manage"] });
    await screen.findByRole("table", { name: "Catalog installs" });
    fireEvent.click(screen.getByRole("button", { name: "Uninstall xlsx-pro" }));
    await answerConfirm(/Uninstall xlsx-pro/, "Uninstall");
    await waitFor(() => expect(summary(calls)).toContain("DELETE /v1/team/skills/installs/s-1"));
    fireEvent.click(screen.getByRole("button", { name: "Reinstall charts" }));
    await waitFor(() =>
      expect(summary(calls)).toContain("POST /v1/team/skills/removed-defaults/s-2/reinstall"),
    );
  });
});

describe("Changing installs (KOBE-316)", () => {
  const TEAM_INSTALL = {
    ...INSTALLS.installs[0],
    skillId: "s-3",
    name: "pdf-kit",
    origin: "team",
    isDefault: false,
    access: "available",
  };
  const LIST = { installs: [...INSTALLS.installs, TEAM_INSTALL], removedDefaults: [] };
  const SWITCHES = (on: boolean) => ({
    personal_skills_disabled: false,
    members_may_add_catalog: true,
    builders_may_install_catalog: on,
  });

  it("a Team admin makes an install Required and sees the warning from 5", async () => {
    const calls = stubApi({
      "GET /v1/team/skills/installs": [200, LIST],
      "PUT /v1/team/skills/installs/s-3": [
        200,
        { semver: "1.1.0", deprecated: false, required_count: 5, warning: "many_required" },
      ],
    });
    renderTeam(<CatalogInstallsSection />, { permissions: ["team.skills.installs.manage"] });
    await screen.findByRole("table", { name: "Catalog installs" });
    fireEvent.change(screen.getByRole("combobox", { name: "Access of pdf-kit" }), {
      target: { value: "required" },
    });
    const form = screen.getByRole("combobox", { name: "Access of pdf-kit" }).closest("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    expect((await screen.findByText(/5 Required skills/)).textContent).toMatch(/limit of 64/);
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(String(put?.body))).toEqual({
      version: "1.1.0",
      pinMode: "within_major",
      access: "required",
    });
  });

  it("a Builder changes team installs while allowed, without Required or Default ones", async () => {
    stubApi({
      "GET /v1/team/skills/installs": [200, LIST],
      "GET /v1/team/skill-review/settings": [200, SWITCHES(true)],
    });
    renderTeam(<CatalogInstallsSection />, {
      role: "builder",
      permissions: ["team.skills.publish"],
    });
    const access = await screen.findByRole("combobox", { name: "Access of pdf-kit" });
    const options = [...(access as HTMLSelectElement).options].map((o) => o.value);
    expect(options).not.toContain("required");
    // The Site default's own install is the Team admins' to change; no uninstall for Builders.
    expect(screen.queryByRole("combobox", { name: "Access of xlsx-pro" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Uninstall/ })).toBeNull();
  });

  it("a Builder gets no controls while the team doesn't allow Builder installs", async () => {
    stubApi({
      "GET /v1/team/skills/installs": [200, LIST],
      "GET /v1/team/skill-review/settings": [200, SWITCHES(false)],
    });
    renderTeam(<CatalogInstallsSection />, {
      role: "builder",
      permissions: ["team.skills.publish"],
    });
    await screen.findByRole("table", { name: "Catalog installs" });
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "Access of pdf-kit" })).toBeNull(),
    );
  });
});
