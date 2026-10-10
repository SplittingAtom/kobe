import { randomUUID } from "node:crypto";
import { schedules, users } from "../../schema/index.js";
import type { schedules as schedulesDomain } from "../../tenancy/schedules.js";
import type { ProbeFixture } from "./types.js";

export const schedulesFixtures: Record<(typeof schedulesDomain.team)[number], ProbeFixture> = {
  schedules: async (tx, teamId) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    await tx.insert(schedules).values({
      teamId,
      userId,
      agentId: randomUUID(),
      prompt: "Probe schedule",
      recurrence: { kind: "daily", at: "08:00" },
      tz: "UTC",
    });
  },
};
