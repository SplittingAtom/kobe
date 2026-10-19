// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerConfirm, renderTeam, stubApi, summary } from "../admin/testing";
import { CatalogInstallsSection } from "../admin/team/skill-editor/catalog-installs-section";
import { notificationTitle } from "../../lib/notifications/format";
import { RetirePanel } from "./retire-panel";

/** KOBE-340 (SK31): retiring versions, and what installs and notifications say. */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const VERSIONS = (mayRetire: boolean) => ({
  status: "active",
  may_retire: mayRetire,
  versions: [
    { semver: "2.0.0", state: "revoked", suspended: false },
    { semver: "1.2.0", state: "withdrawn", suspended: false },
    { semver: "1.1.0", state: "deprecated", suspended: false },
    { semver: "1.0.0", state: "approved", suspended: false },
  ],
});

describe("the retire panel", () => {
  it("offers a Site admin each act a version's state allows, confirmed, with a note", async () => {
    const calls = stubApi({
      "GET /v1/site/skills/catalog/s1/versions": [200, VERSIONS(true)],
      "POST /v1/site/skills/catalog/s1/versions/1.0.0/revoke": [
        200,
        { state: "revoked", notified: true },
      ],
      "POST /v1/site/skills/catalog/s1/versions/2.0.0/unrevoke": [
        200,
        { state: "approved", notified: true },
      ],
    });
    render(<RetirePanel skillId="s1" name="sales" candidates={[]} />);
    const table = await screen.findByRole("table", { name: "Versions of sales" });
    const row = (v: string) => within(table).getByText(v).closest("tr") as HTMLElement;
    expect(
      within(row("1.0.0"))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Deprecate", "Withdraw", "Revoke"]);
    expect(
      within(row("1.1.0"))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Undo deprecation", "Withdraw", "Revoke"]);
    expect(
      within(row("1.2.0"))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Revoke"]);
    expect(
      within(row("2.0.0"))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Unrevoke"]);
    await userEvent.type(screen.getByLabelText("Note (optional)"), "Leaks data.");
    fireEvent.click(within(row("1.0.0")).getByRole("button", { name: "Revoke" }));
    await answerConfirm(/Revoke sales 1\.0\.0/, "Revoke");
    expect(
      await screen.findByText("sales 1.0.0 is revoked; the teams and people with it were told."),
    ).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({ note: "Leaks data." });
    fireEvent.click(within(row("2.0.0")).getByRole("button", { name: "Unrevoke" }));
    await answerConfirm(/Unrevoke sales 2\.0\.0/, "Unrevoke");
    await waitFor(() =>
      expect(summary(calls)).toContain("POST /v1/site/skills/catalog/s1/versions/2.0.0/unrevoke"),
    );
  });

  it("offers a maintainer Deprecate and its undo only, and deprecating the skill with a replacement", async () => {
    const calls = stubApi({
      "GET /v1/site/skills/catalog/s1/versions": [200, VERSIONS(false)],
      "POST /v1/site/skills/catalog/s1/deprecate": [200, { state: "deprecated", notified: true }],
    });
    render(
      <RetirePanel skillId="s1" name="sales" candidates={[{ id: "s2", name: "sales-next" }]} />,
    );
    const table = await screen.findByRole("table", { name: "Versions of sales" });
    expect(
      within(table)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Undo deprecation", "Deprecate"]);
    await userEvent.selectOptions(screen.getByLabelText("Replacement"), "s2");
    fireEvent.click(screen.getByRole("button", { name: "Deprecate sales" }));
    await answerConfirm(/Deprecate sales\?/, "Deprecate");
    await waitFor(() =>
      expect(summary(calls)).toContain("POST /v1/site/skills/catalog/s1/deprecate"),
    );
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({ replacementId: "s2" });
  });
});

describe("installs show a retirement", () => {
  it("Revoked or Withdrawn — choose a version; deprecated with its replacement", async () => {
    const install = (name: string, retirement: unknown) => ({
      skill_id: `id-${name}`,
      name,
      version_id: "v",
      semver: "1.0.0",
      pin_mode: "pinned",
      access: "default_on",
      origin: "team",
      installed_by: "u",
      updated_at: "2026-10-18T10:00:00.000Z",
      is_default: false,
      retirement,
    });
    stubApi({
      "GET /v1/team/skills/installs": [
        200,
        {
          installs: [
            install("a", { kind: "revoked", semver: "1.0.0", replacement: null }),
            install("b", { kind: "withdrawn", semver: "1.0.0", replacement: null }),
            install("c", {
              kind: "deprecated",
              semver: "1.0.0",
              replacement: { id: "x", name: "c-next" },
            }),
          ],
          removed_defaults: [],
        },
      ],
    });
    renderTeam(<CatalogInstallsSection />, { permissions: [] });
    expect(await screen.findByText("1.0.0 was revoked — choose a version.")).toBeTruthy();
    expect(screen.getByText("1.0.0 was withdrawn — choose a version.")).toBeTruthy();
    expect(screen.getByText("1.0.0 is deprecated. Use c-next instead.")).toBeTruthy();
  });
});

describe("retirement notifications", () => {
  const base = {
    notificationId: "n",
    scheduleId: null,
    threadId: null,
    runId: null,
    readAt: null,
    createdAt: "2026-10-19T08:00:00Z",
    skillId: "s",
    skillName: "sales",
  } as const;
  it.each([
    ["skill.deprecated", undefined, "sales was deprecated"],
    ["skill.version.deprecated", "1.1.0", "sales 1.1.0 was deprecated"],
    ["skill.version.withdrawn", "1.2.0", "sales 1.2.0 was withdrawn — choose a version"],
    ["skill.version.revoked", "2.0.0", "sales 2.0.0 was revoked — choose a version"],
    ["skill.version.unrevoked", "2.0.0", "sales 2.0.0 is available again"],
  ] as const)("%s", (kind, semver, words) => {
    expect(notificationTitle({ ...base, kind, skillSemver: semver })).toBe(words);
  });
});

describe("undoing a skill's deprecation", () => {
  it("offers Undo on a deprecated skill", async () => {
    const calls = stubApi({
      "GET /v1/site/skills/catalog/s1/versions": [
        200,
        { ...VERSIONS(false), status: "deprecated" },
      ],
      "POST /v1/site/skills/catalog/s1/undeprecate": [200, { state: "active", notified: true }],
    });
    render(<RetirePanel skillId="s1" name="sales" candidates={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Undo the deprecation of sales" }));
    expect(await screen.findByText("sales is active again.")).toBeTruthy();
    expect(summary(calls)).toContain("POST /v1/site/skills/catalog/s1/undeprecate");
    expect(screen.queryByRole("button", { name: "Deprecate sales" })).toBeNull();
  });
});
