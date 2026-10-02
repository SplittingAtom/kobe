import { randomUUID } from "node:crypto";
import type { KobeTx } from "../client.js";
import { teamMembers } from "../schema/index.js";
import type { TeamTable } from "../tenancy.js";

/**
 * One row-inserting fixture per team table, used by the cross-team probe suite. Typed as a
 * Record over TeamTable so adding a team table without a fixture fails to compile.
 */
export const PROBE_FIXTURES: Readonly<
  Record<TeamTable, (tx: KobeTx, teamId: string) => Promise<void>>
> = {
  team_members: async (tx, teamId) => {
    await tx.insert(teamMembers).values({ teamId, userId: randomUUID(), role: "member" });
  },
};
