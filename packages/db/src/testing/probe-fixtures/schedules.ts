import { randomUUID } from "node:crypto";
import {
  notificationEmails,
  notifications,
  runSkippedActions,
  runs,
  schedules,
  threads,
  users,
} from "../../schema/index.js";
import type { schedules as schedulesDomain } from "../../tenancy/schedules.js";
import type { ProbeFixture } from "./types.js";

async function scheduledRun(tx: Parameters<ProbeFixture>[0], teamId: string) {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
  const [schedule] = await tx
    .insert(schedules)
    .values({
      teamId,
      userId,
      agentId: randomUUID(),
      prompt: "Probe schedule",
      recurrence: { kind: "daily", at: "08:00" },
      tz: "UTC",
    })
    .returning({ id: schedules.id });
  const [thread] = await tx
    .insert(threads)
    .values({ teamId, ownerUserId: userId, scheduleId: schedule?.id })
    .returning({ id: threads.id });
  const [run] = await tx
    .insert(runs)
    .values({ teamId, threadId: thread?.id ?? "", trigger: "schedule" })
    .returning({ id: runs.id });
  if (!schedule || !thread || !run) throw new Error("probe: scheduled run insert failed");
  return { userId, scheduleId: schedule.id, threadId: thread.id, runId: run.id };
}

const scheduledRunFixtures: Record<
  "notifications" | "notification_emails" | "run_skipped_actions",
  ProbeFixture
> = {
  notifications: async (tx, teamId) => {
    const s = await scheduledRun(tx, teamId);
    await tx.insert(notifications).values({
      teamId,
      userId: s.userId,
      kind: "schedule.run.succeeded",
      scheduleId: s.scheduleId,
      threadId: s.threadId,
      runId: s.runId,
    });
  },
  notification_emails: async (tx, teamId) => {
    const s = await scheduledRun(tx, teamId);
    const [n] = await tx
      .insert(notifications)
      .values({
        teamId,
        userId: s.userId,
        kind: "schedule.run.failed",
        scheduleId: s.scheduleId,
        threadId: s.threadId,
        runId: s.runId,
      })
      .returning({ id: notifications.id });
    if (!n) throw new Error("probe: notification insert returned nothing");
    await tx
      .insert(notificationEmails)
      .values({ teamId, notificationId: n.id, recipientId: s.userId });
  },
  run_skipped_actions: async (tx, teamId) => {
    const s = await scheduledRun(tx, teamId);
    await tx.insert(runSkippedActions).values({
      teamId,
      runId: s.runId,
      toolCallId: "call-1",
      tool: "bash",
      riskClass: "write",
      reason: "scheduled_run_no_prompt",
    });
  },
};

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
  ...scheduledRunFixtures,
};
