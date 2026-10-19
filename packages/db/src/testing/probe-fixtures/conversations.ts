import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { KobeTx } from "../../client.js";
import {
  answerFeedback,
  answerFeedbackHistory,
  events,
  runEvents,
  runs,
  threadAppResults,
  threadEntries,
  threads,
  users,
} from "../../schema/index.js";
import type { conversations } from "../../tenancy/conversations.js";
import type { ProbeFixture } from "./types.js";

async function insertThread(
  tx: KobeTx,
  teamId: string,
  values: Partial<typeof threads.$inferInsert> = {},
): Promise<string> {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
  const [row] = await tx
    .insert(threads)
    .values({ teamId, ownerUserId: userId, title: "Probe", ...values })
    .returning({ id: threads.id });
  if (!row) throw new Error("probe: thread insert returned nothing");
  return row.id;
}

async function insertRun(tx: KobeTx, teamId: string, threadId?: string): Promise<string> {
  const thread = threadId ?? (await insertThread(tx, teamId));
  const [row] = await tx
    .insert(runs)
    .values({ teamId, threadId: thread, trigger: "user", status: "running", startedAt: new Date() })
    .returning({ id: runs.id });
  if (!row) throw new Error("probe: run insert returned nothing");
  return row.id;
}

export const conversationsFixtures: Record<(typeof conversations.team)[number], ProbeFixture> = {
  threads: async (tx, teamId) => {
    // A pinned, archived, renamed fork of another thread (KOBE-215): the fork key is per team.
    const source = await insertThread(tx, teamId);
    const now = new Date();
    await insertThread(tx, teamId, {
      forkedFromThreadId: source,
      forkedAtEntryId: "probe",
      pinnedAt: now,
      archivedAt: now,
      titleLocked: true,
    });
    // Shared with the whole team (KOBE-221): still confined to it.
    await insertThread(tx, teamId, { sharedToTeam: true });
  },
  thread_entries: async (tx, teamId) => {
    const threadId = await insertThread(tx, teamId);
    await tx
      .insert(threadEntries)
      .values({ teamId, threadId, entryId: "probe", type: "message", payload: { probe: true } });
  },
  runs: async (tx, teamId) => {
    await insertRun(tx, teamId);
  },
  run_events: async (tx, teamId) => {
    const runId = await insertRun(tx, teamId);
    await tx.insert(runEvents).values({ teamId, runId, type: "run.started" });
  },
  events: async (tx, teamId) => {
    await tx.insert(events).values({ teamId, kind: "probe", ref: { probe: true } });
  },
  answer_feedback: async (tx, teamId) => {
    // A thumbs down with a comment on an entry of a team-shared thread (KOBE-275), by its owner.
    const threadId = await insertThread(tx, teamId, { sharedToTeam: true });
    const [thread] = await tx
      .select({ ownerUserId: threads.ownerUserId })
      .from(threads)
      .where(eq(threads.id, threadId));
    if (!thread) throw new Error("probe: thread vanished");
    const runId = await insertRun(tx, teamId, threadId);
    await tx
      .insert(threadEntries)
      .values({ teamId, threadId, entryId: "answer", type: "message", payload: { probe: true } });
    await tx.insert(answerFeedback).values({
      teamId,
      threadId,
      runId,
      entryId: "answer",
      userId: thread.ownerUserId,
      rating: "down",
      reasons: ["wrong"],
      comment: "probe comment",
    });
  },
  answer_feedback_history: async (tx, teamId) => {
    // A held rating's kept copy (KOBE-275 review B1); written here directly, as the trigger would.
    const threadId = await insertThread(tx, teamId);
    const [thread] = await tx
      .select({ ownerUserId: threads.ownerUserId })
      .from(threads)
      .where(eq(threads.id, threadId));
    if (!thread) throw new Error("probe: thread vanished");
    const runId = await insertRun(tx, teamId, threadId);
    const now = new Date();
    await tx.insert(answerFeedbackHistory).values({
      teamId,
      feedbackId: randomUUID(),
      threadId,
      runId,
      userId: thread.ownerUserId,
      rating: "down",
      reasons: ["other"],
      comment: "probe kept comment",
      ratedAt: now,
      ratedUpdatedAt: now,
      change: "cleared",
    });
  },
  thread_app_results: async (tx, teamId) => {
    const threadId = await insertThread(tx, teamId);
    const runId = await insertRun(tx, teamId, threadId);
    await tx.insert(threadAppResults).values({
      teamId,
      threadId,
      runId,
      piName: "mcp__probe__open",
      inputSha256: "0".repeat(64),
      connectorId: randomUUID(),
      tool: "open",
      templateUri: "ui://probe/app",
      templateSha256: "1".repeat(64),
      appId: "2".repeat(64),
      storage: "inline",
      result: { content: [] },
      bytes: 14,
    });
  },
};
