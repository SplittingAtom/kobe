/**
 * Roster rows for the Agents page tests (KOBE-569): what the server (KOBE-566) answers per role,
 * following the spec's §5 matrix. The page renders `actions` as given; these fixtures stand in for
 * the server's decisions.
 */
import type { AgentRosterActions, AgentRosterRow } from "@kobe/protocol";
import { ME, TEAM } from "../admin/testing";

export const NO_ACTIONS: AgentRosterActions = {
  view: true,
  viewDefinition: false,
  edit: false,
  fork: false,
  assignTeam: null,
  assignSite: null,
  withdrawTeam: false,
  withdrawSite: false,
  decide: false,
  remove: false,
  pin: false,
  suspendHere: false,
  resumeHere: false,
  suspendSiteWide: false,
  resumeSiteWide: false,
  adopt: false,
};

export function row(
  over: Partial<Omit<AgentRosterRow, "actions">> & {
    readonly actions?: Partial<AgentRosterActions>;
  },
): AgentRosterRow {
  const { actions, ...rest } = over;
  return {
    agentId: "a-1",
    kind: "personal",
    slug: "notes",
    name: "Notes",
    description: "Takes notes.",
    dangerous: false,
    ownerUserId: ME.id,
    ownerName: ME.name,
    boundTeamId: null,
    status: "active",
    currentVersion: 2,
    versionInEffect: 2,
    updateAvailable: false,
    entry: null,
    archivedAt: null,
    updatedAt: "2026-11-01T10:00:00Z",
    ...rest,
    actions: { ...NO_ACTIONS, ...actions },
  };
}

export const entry = (over: Partial<NonNullable<AgentRosterRow["entry"]>> = {}) => ({
  agentId: "a-1",
  target: "team" as const,
  teamId: TEAM.id,
  state: "active" as const,
  versionRule: "latest" as const,
  pinnedVersion: null,
  assignedBy: ME.id,
  assignedAt: "2026-11-01T10:00:00Z",
  decidedBy: null,
  decidedAt: null,
  note: null,
  removedAt: null,
  ...over,
});

export const page = (
  tab: "personal" | "team" | "site",
  rows: AgentRosterRow[],
  nextCursor: string | null = null,
) => ({
  tab,
  rows,
  nextCursor,
});
