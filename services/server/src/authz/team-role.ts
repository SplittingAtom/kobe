import type { TeamRole as DbTeamRole } from "@kobe/db";
import type { TeamRole } from "@kobe/protocol";

/**
 * Temporary bridge (KOBE-576): the `team_role` enum in the database still says `builder` until
 * KOBE-577 renames it (MG1); the protocol says `contributor`. KOBE-578 deletes this file.
 */
export const toProtocolTeamRole = (role: DbTeamRole): TeamRole =>
  role === "builder" ? "contributor" : role;
