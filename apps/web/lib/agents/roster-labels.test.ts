import { describe, expect, it } from "vitest";
import { entry, row } from "../../components/agents/roster-fixtures";
import { ME, TEAM } from "../../components/admin/testing";
import {
  editHref,
  pinLabel,
  reachItems,
  rosterStatusLabel,
  updateAvailableLabel,
  versionInEffectLabel,
} from "./roster-labels";

describe("roster row labels (KOBE-569, AR1, §6.5, §6.6)", () => {
  it("names every status, a draft per tab and an Unavailable entry's reason", () => {
    expect(rosterStatusLabel(row({ status: "active" }), "team")).toBe("Active");
    expect(rosterStatusLabel(row({ status: "proposed" }), "team")).toBe("Proposed");
    expect(rosterStatusLabel(row({ status: "not_published" }), "personal")).toBe("Draft");
    expect(rosterStatusLabel(row({ status: "not_published" }), "team")).toBe("Not published yet");
    expect(rosterStatusLabel(row({ status: "suspended_here" }), "team")).toBe("Suspended here");
    expect(rosterStatusLabel(row({ status: "suspended_site" }), "site")).toBe(
      "Suspended site-wide",
    );
    expect(rosterStatusLabel(row({ status: "archived" }), "team")).toBe("Archived");
    const gone = { ...row({}), status: "unavailable", unavailableReason: "owner_left" };
    expect(rosterStatusLabel(gone as never, "team")).toBe("Unavailable: its owner left the team");
  });

  it("shows the version in effect, Draft for an own unpublished agent, else Not published yet", () => {
    expect(versionInEffectLabel(row({ versionInEffect: 3 }), ME.id)).toBe("v3");
    expect(versionInEffectLabel(row({ versionInEffect: null }), ME.id)).toBe("Draft");
    expect(versionInEffectLabel(row({ versionInEffect: null, ownerUserId: "u-2" }), ME.id)).toBe(
      "Not published yet",
    );
  });

  it("says Update available: vN for a pinned entry behind, and the pin", () => {
    const pinned = row({
      versionInEffect: 1,
      currentVersion: 3,
      updateAvailable: true,
      entry: entry({ versionRule: "pinned", pinnedVersion: 1 }),
    });
    expect(updateAvailableLabel(pinned)).toBe("Update available: v3");
    expect(pinLabel(pinned)).toBe("Pinned to v1");
    expect(updateAvailableLabel(row({}))).toBeNull();
    expect(pinLabel(row({ entry: entry() }))).toBeNull();
  });

  it("lists the Reach: Private, teams, the site, proposals, declines and bindings", () => {
    expect(reachItems(row({ reach: [] }), TEAM).map((i) => i.label)).toEqual(["Private"]);
    const reach = [
      {
        target: "team" as const,
        teamId: TEAM.id,
        teamName: TEAM.name,
        state: "active" as const,
        note: null,
      },
      {
        target: "team" as const,
        teamId: "t-2",
        teamName: "Legal",
        state: "proposed" as const,
        note: null,
      },
      {
        target: "site" as const,
        teamId: null,
        teamName: null,
        state: "removed" as const,
        note: "Too narrow",
      },
      {
        target: "team" as const,
        teamId: "t-3",
        teamName: "Ops",
        state: "removed" as const,
        note: null,
      },
    ];
    const items = reachItems(row({ reach, boundTeamId: TEAM.id }), TEAM);
    expect(items.map((i) => i.label)).toEqual([
      "Bound to Team: Finance",
      "Team: Finance",
      "Proposed to Legal",
      "Declined for Site: Too narrow",
    ]);
    // Another team's roster (one the owner may have left) can be withdrawn from here.
    expect(items.map((i) => i.withdrawFrom)).toEqual([
      null,
      null,
      { teamId: "t-2", teamName: "Legal" },
      null,
    ]);
  });

  it("leads Edit to the owner's editor, the team builder or the gallery editor", () => {
    expect(editHref(row({}))).toBe("/agents/a-1");
    expect(editHref(row({ kind: "team_owned" }))).toBe("/admin/team/agents/a-1");
    expect(editHref(row({ kind: "gallery" }))).toBe("/admin/site/gallery/a-1");
  });
});
