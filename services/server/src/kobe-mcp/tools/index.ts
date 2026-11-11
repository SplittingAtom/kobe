import type { KobeTool } from "../catalog.js";
import { KOBE_SITE_TOOLS } from "./site/index.js";
import { teamMembersList, teamMembersSetRole } from "./team-members.js";

/**
 * Every Kobe MCP admin tool (KOBE-619 framework; KA-4/KA-5 add the Team and Site console lists).
 * The contract test (`kobe-mcp.db.test.ts`) runs each one's route as a person without the tool's
 * permission.
 */
export const KOBE_ADMIN_TOOLS: readonly KobeTool[] = [
  teamMembersList,
  teamMembersSetRole,
  ...KOBE_SITE_TOOLS,
];

export function kobeToolByName(name: string): KobeTool | undefined {
  return KOBE_ADMIN_TOOLS.find((t) => t.name === name);
}
