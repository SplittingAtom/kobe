import { describe, expect, it } from "vitest";
import {
  AGENT_ROSTER_CAP,
  AGENT_ROSTER_ERROR_CODES,
  AGENT_ROSTER_ERROR_STATUS,
  AGENT_ROSTER_WRITE_RATE,
  agentRosterPageSchema,
  agentRosterQuerySchema,
  agentRosterRowSchema,
  assignAgentRequestSchema,
  updateAgentRosterEntryRequestSchema,
} from "./index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-08T12:00:00.000Z";

describe("agent roster contract (KOBE-566)", () => {
  it("pins the caps and the write rate (AR6, §6.8)", () => {
    expect(AGENT_ROSTER_CAP).toBe(200);
    expect(AGENT_ROSTER_WRITE_RATE).toEqual({ windowMs: 600_000, max: 60 });
  });

  it("maps every error code to a status, 422 for a bound agent and 409 for a rostered delete", () => {
    expect(Object.keys(AGENT_ROSTER_ERROR_STATUS)).toEqual([...AGENT_ROSTER_ERROR_CODES]);
    expect(AGENT_ROSTER_ERROR_STATUS.agent_bound_to_team).toBe(422);
    expect(AGENT_ROSTER_ERROR_STATUS.agent_rostered).toBe(409);
  });

  it("takes latest or a positive version as the version rule", () => {
    const ok = (versionRule: unknown) =>
      assignAgentRequestSchema.safeParse({ target: "team", versionRule }).success;
    expect(ok("latest")).toBe(true);
    expect(ok(3)).toBe(true);
    expect(ok(0)).toBe(false);
    expect(ok("pinned")).toBe(false);
    expect(assignAgentRequestSchema.safeParse({ target: "personal" }).success).toBe(false);
  });

  it("never accepts proposed as an admin's state, and bounds the note", () => {
    const parse = (body: unknown) => updateAgentRosterEntryRequestSchema.safeParse(body).success;
    expect(parse({ state: "removed", note: "Not for us" })).toBe(true);
    expect(parse({ state: "proposed" })).toBe(false);
    expect(parse({ state: "removed", note: "x".repeat(501) })).toBe(false);
  });

  it("carries the roster's pending proposal count for its admins (KOBE-570)", () => {
    expect(
      agentRosterPageSchema.safeParse({ tab: "team", rows: [], nextCursor: null }).success,
    ).toBe(true);
    expect(
      agentRosterPageSchema.safeParse({ tab: "team", rows: [], nextCursor: null, proposedCount: 3 })
        .success,
    ).toBe(true);
    expect(
      agentRosterPageSchema.safeParse({
        tab: "team",
        rows: [],
        nextCursor: null,
        proposedCount: -1,
      }).success,
    ).toBe(false);
  });

  it("parses the query with a coerced limit", () => {
    expect(agentRosterQuerySchema.parse({ tab: "site", limit: "20" })).toEqual({
      tab: "site",
      limit: 20,
    });
    expect(agentRosterQuerySchema.safeParse({ tab: "all" }).success).toBe(false);
  });

  it("describes a row with its entry and actions", () => {
    const row = {
      agentId: ID,
      kind: "personal",
      slug: "helper",
      name: "Helper",
      dangerous: false,
      ownerUserId: ID,
      ownerName: "Ann",
      boundTeamId: null,
      status: "active",
      currentVersion: 3,
      versionInEffect: 2,
      updateAvailable: true,
      entry: {
        agentId: ID,
        target: "team",
        teamId: ID,
        state: "active",
        versionRule: "pinned",
        pinnedVersion: 2,
        assignedBy: ID,
        assignedAt: NOW,
        decidedBy: null,
        decidedAt: null,
        note: null,
        removedAt: null,
      },
      archivedAt: null,
      updatedAt: NOW,
      actions: {
        view: true,
        viewDefinition: true,
        edit: false,
        fork: true,
        assignTeam: null,
        assignSite: "propose",
        withdrawTeam: false,
        withdrawSite: false,
        decide: false,
        remove: true,
        pin: true,
        suspendHere: true,
        resumeHere: false,
        suspendSiteWide: false,
        resumeSiteWide: false,
        adopt: true,
      },
    };
    expect(agentRosterRowSchema.safeParse(row).success).toBe(true);
    // KOBE-571: the fork's binding, lineage and the declined marker (additive).
    expect(
      agentRosterRowSchema.safeParse({
        ...row,
        forkBoundTeamId: ID,
        forkedFrom: { agentId: ID, version: 2, name: "Source", kind: "team_owned" },
        reach: [
          {
            target: "team",
            teamId: ID,
            teamName: "T",
            state: "removed",
            note: null,
            declined: true,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      agentRosterRowSchema.safeParse({
        ...row,
        forkedFrom: { agentId: ID, version: null, name: null, kind: null },
      }).success,
    ).toBe(true);
    const { adopt: _adopt, ...withoutAdopt } = row.actions;
    // Additive: a row from an older server without `adopt` still parses.
    expect(agentRosterRowSchema.safeParse({ ...row, actions: withoutAdopt }).success).toBe(true);
    // KOBE-570: team admins get the inventory's usage on the row (additive, optional).
    const usage = {
      runCount: 4,
      lastRunAt: NOW,
      tokens: 1200,
      schedules: [
        {
          scheduleId: ID,
          ownerUserId: ID,
          ownerName: "Ann",
          status: "paused",
          pausedBy: "agent_unavailable",
          nextDueAt: null,
        },
      ],
      orbitScore: { status: "passed", attackSuccessRate: 0.1, at: NOW },
      canExport: true,
    };
    expect(agentRosterRowSchema.safeParse({ ...row, usage }).success).toBe(true);
    expect(
      agentRosterRowSchema.safeParse({ ...row, usage: { ...usage, runCount: -1 } }).success,
    ).toBe(false);
  });
});
