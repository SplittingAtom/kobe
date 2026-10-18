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
