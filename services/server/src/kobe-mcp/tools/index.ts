import type { KobeTool } from "../catalog.js";
import { teamAgentsList, teamAgentsResume, teamAgentsSuspend } from "./team-agents.js";
import { teamBudgetsGet, teamBudgetsSetMember, teamBudgetsSetTeam } from "./team-budgets.js";
import {
  teamConnectorsDisable,
  teamConnectorsList,
  teamConnectorsSetExposure,
} from "./team-connectors.js";
import {
  teamEgressDisable,
  teamEgressEnable,
  teamEgressList,
  teamEgressRequestsDecide,
  teamEgressRequestsList,
} from "./team-egress.js";
import { teamInvitesCreate, teamInvitesList, teamInvitesRevoke } from "./team-invites.js";
import { teamMembersList, teamMembersRemove, teamMembersSetRole } from "./team-members.js";
import { teamMemoryGet, teamMemorySet } from "./team-memory.js";
import { teamModelsList, teamModelsSet } from "./team-models.js";
import { teamAuditList, teamUsageGet } from "./team-reports.js";
import { teamSchedulesList, teamSchedulesPause, teamSchedulesResume } from "./team-schedules.js";
import {
  teamSkillReviewsDecide,
  teamSkillReviewsList,
  teamSkillInstallsList,
} from "./team-skills.js";

/**
 * Every Kobe MCP admin tool: the Team console list of spec §5 (KOBE-621, KA-4) on the KOBE-619
 * framework; KA-5 adds the Site console list. The contract test (`kobe-mcp-team.db.test.ts`) runs each
 * one as a person without the tool's permission and as one holding it.
 */
export const KOBE_ADMIN_TOOLS: readonly KobeTool[] = [
  teamMembersList,
  teamMembersSetRole,
  teamMembersRemove,
  teamInvitesList,
  teamInvitesCreate,
  teamInvitesRevoke,
  teamConnectorsList,
  teamConnectorsSetExposure,
  teamConnectorsDisable,
  teamSkillInstallsList,
  teamSkillReviewsList,
  teamSkillReviewsDecide,
  teamModelsList,
  teamModelsSet,
  teamBudgetsGet,
  teamBudgetsSetTeam,
  teamBudgetsSetMember,
  teamMemoryGet,
  teamMemorySet,
  teamEgressList,
  teamEgressEnable,
  teamEgressDisable,
  teamEgressRequestsList,
  teamEgressRequestsDecide,
  teamAgentsList,
  teamAgentsSuspend,
  teamAgentsResume,
  teamSchedulesList,
  teamSchedulesPause,
  teamSchedulesResume,
  teamUsageGet,
  teamAuditList,
];

export function kobeToolByName(name: string): KobeTool | undefined {
  return KOBE_ADMIN_TOOLS.find((t) => t.name === name);
}
