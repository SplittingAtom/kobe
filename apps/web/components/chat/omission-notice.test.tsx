// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OmissionNotice, omissionText } from "./omission-notice";

afterEach(cleanup);

describe("OmissionNotice (KOBE-77)", () => {
  it("lists every omitted item with its reason", () => {
    render(
      <OmissionNotice
        payload={{
          items: [
            { kind: "connector", name: "github", reason: "not_user_connected" },
            { kind: "connector", name: "jira", reason: "not_team_enabled" },
            { kind: "skill", name: "sql-helper", reason: "blocklisted" },
          ],
        }}
      />,
    );
    const note = screen.getByRole("note");
    expect(within(note).getByText(/left out of this run/)).toBeTruthy();
    const rows = within(note)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(rows).toEqual([
      expect.stringContaining("Connector github"),
      expect.stringContaining("Connector jira"),
      expect.stringContaining("Skill sql-helper"),
    ]);
    expect(rows[0]).toContain("not connected");
    expect(rows[1]).toContain("not enabled for your team");
    expect(rows[2]).toContain("blocked");
  });

  it("has a sentence for every kind and reason", () => {
    const reasons = [
      "agent_exclusive",
      "team_disabled",
      "blocklisted",
      "shadowed_by_agent",
      "not_team_enabled",
      "not_user_connected",
      "no_team_default",
      "not_approved",
    ] as const;
    for (const kind of ["skill", "connector", "model"] as const) {
      for (const reason of reasons) {
        expect(omissionText({ kind, name: "x", reason }).length).toBeGreaterThan(5);
      }
    }
  });

  it("renders a reason it does not know generically", () => {
    const item = { kind: "skill", name: "x", reason: "from_the_future" } as unknown as Parameters<
      typeof omissionText
    >[0];
    expect(omissionText(item)).toBe("Skill x: it was left out of this run");
  });

  it("explains not_approved", () => {
    expect(omissionText({ kind: "skill", name: "sql", reason: "not_approved" })).toBe(
      "Skill sql: it is not approved for your team",
    );
  });
});
