import { randomUUID } from "node:crypto";
import {
  retentionBlobDeletions,
  teamInvitations,
  teamMembers,
  teamRetention,
  users,
} from "../../schema/index.js";
import type { identity } from "../../tenancy/identity.js";
import type { ProbeFixture } from "./types.js";

async function insertUser(tx: Parameters<ProbeFixture>[0]): Promise<string> {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
  return userId;
}

export const identityFixtures: Record<(typeof identity.team)[number], ProbeFixture> = {
  team_members: async (tx, teamId) => {
    const userId = await insertUser(tx);
    await tx.insert(teamMembers).values({ teamId, userId, role: "member" });
  },
  team_invitations: async (tx, teamId) => {
    const invitedBy = await insertUser(tx);
    await tx.insert(teamInvitations).values({
      teamId,
      email: `${randomUUID()}@probe.test`,
      role: "member",
      invitedBy,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  },
  team_retention: async (tx, teamId) => {
    const updatedBy = await insertUser(tx);
    await tx.insert(teamRetention).values({ teamId, period: "90d", updatedBy });
  },
  retention_blob_deletions: async (tx, teamId) => {
    const ownerUserId = await insertUser(tx);
    await tx
      .insert(retentionBlobDeletions)
      .values({ teamId, key: `teams/${teamId}/uploads/${randomUUID()}`, ownerUserId });
  },
};
