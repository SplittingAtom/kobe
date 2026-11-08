import { describe, expect, it } from "vitest";
import type { RosterEntryRecord } from "./roster.js";
import { resolvedVersion } from "./roster.js";
import { entryUnavailable, isLentAgent, lendingIn } from "./roster-resolution.js";
import type { AgentRecord } from "./store.js";

const T = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

const entry = (over: Partial<RosterEntryRecord>): RosterEntryRecord => ({
  agentId: "a",
  target: "team",
  teamId: T,
  state: "active",
  versionRule: "latest",
  pinnedVersion: null,
  assignedBy: "u",
  assignedAt: new Date(0),
  decidedBy: null,
  decidedAt: null,
  note: null,
  removedAt: null,
  ...over,
});
const team = (over: Partial<RosterEntryRecord> = {}) => entry({ target: "team", ...over });
const site = (over: Partial<RosterEntryRecord> = {}) =>
  entry({ target: "site", teamId: null, ...over });
const member = { member: true, deactivated: false };
const left = { member: false, deactivated: false };
const deactivated = { member: true, deactivated: true };
const unbound = { boundTeamId: null };

describe("entryUnavailable (AR10)", () => {
  it("a team entry needs the owner in the team; any entry needs an active owner", () => {
    expect(entryUnavailable(team(), member)).toBeNull();
    expect(entryUnavailable(team(), left)).toBe("owner_left");
    expect(entryUnavailable(team(), deactivated)).toBe("owner_deactivated");
    expect(entryUnavailable(site(), left)).toBeNull();
    expect(entryUnavailable(site(), deactivated)).toBe("owner_deactivated");
  });
});

describe("lendingIn (AR9, §6.2)", () => {
  it("is null without a live entry: proposed, removed or no entry at all", () => {
    expect(lendingIn(T, unbound, null, null, member)).toBeNull();
    expect(lendingIn(T, unbound, team({ state: "proposed" }), null, member)).toBeNull();
    expect(
      lendingIn(T, unbound, team({ state: "removed" }), site({ state: "removed" }), member),
    ).toBeNull();
    expect(lendingIn(T, unbound, null, site({ state: "proposed" }), member)).toBeNull();
  });

  it("prefers an eligible active team entry, with its version rule", () => {
    const pinned = team({ versionRule: "pinned", pinnedVersion: 2 });
    const got = lendingIn(T, unbound, pinned, site(), member);
    expect(got).toEqual({ entry: pinned, unavailable: null, suspendedSiteWide: false });
    expect(resolvedVersion(got?.entry ?? pinned, 5)).toBe(2);
  });

  it("falls back to the site entry when the team entry's owner left", () => {
    const s = site();
    expect(lendingIn(T, unbound, team(), s, left)).toEqual({
      entry: s,
      unavailable: null,
      suspendedSiteWide: false,
    });
  });

  it("is Unavailable with the reason when no entry has an eligible owner", () => {
    expect(lendingIn(T, unbound, team(), null, left)).toMatchObject({ unavailable: "owner_left" });
    expect(lendingIn(T, unbound, team(), site(), deactivated)).toMatchObject({
      unavailable: "owner_deactivated",
    });
    expect(lendingIn(T, unbound, null, site(), deactivated)).toMatchObject({
      unavailable: "owner_deactivated",
    });
  });

  it("a site entry suspended site-wide lends a suspended agent, team entry or not (§6.5)", () => {
    expect(lendingIn(T, unbound, null, site({ state: "suspended" }), member)).toMatchObject({
      suspendedSiteWide: true,
    });
    expect(lendingIn(T, unbound, team(), site({ state: "suspended" }), member)).toMatchObject({
      suspendedSiteWide: true,
      entry: { target: "team" },
    });
  });

  it("a bound agent is lent only in its team, never through the site roster (AR8)", () => {
    expect(lendingIn(T, { boundTeamId: OTHER }, team(), null, member)).toBeNull();
    expect(lendingIn(T, { boundTeamId: T }, team(), null, member)).toMatchObject({
      unavailable: null,
    });
    expect(lendingIn(T, { boundTeamId: T }, null, site(), member)).toBeNull();
  });
});

describe("isLentAgent", () => {
  const agent = (over: Partial<AgentRecord>) => ({ scope: "personal", ownerUserId: "o", ...over });
  it("is someone else's personal agent only", () => {
    expect(isLentAgent(agent({}) as AgentRecord, { userId: "me" })).toBe(true);
    expect(isLentAgent(agent({ ownerUserId: "me" }) as AgentRecord, { userId: "me" })).toBe(false);
    expect(
      isLentAgent(agent({ scope: "gallery", ownerUserId: null }) as AgentRecord, { userId: "me" }),
    ).toBe(false);
  });
});
