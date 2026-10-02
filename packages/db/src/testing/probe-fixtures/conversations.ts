import { randomUUID } from "node:crypto";
import type { KobeTx } from "../../client.js";
import { events, runEvents, runs, threadEntries, threads, users } from "../../schema/index.js";
import type { conversations } from "../../tenancy/conversations.js";
import type { ProbeFixture } from "./types.js";

async function insertThread(tx: KobeTx, teamId: string): Promise<string> {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
  const [row] = await tx
    .insert(threads)
    .values({ teamId, ownerUserId: userId, title: "Probe" })
    .returning({ id: threads.id });
  if (!row) throw new Error("probe: thread insert returned nothing");
  return row.id;
}

async function insertRun(tx: KobeTx, teamId: string): Promise<string> {
  const threadId = await insertThread(tx, teamId);
  const [row] = await tx
    .insert(runs)
    .values({ teamId, threadId, trigger: "user", status: "running", startedAt: new Date() })
    .returning({ id: runs.id });
  if (!row) throw new Error("probe: run insert returned nothing");
  return row.id;
}

export const conversationsFixtures: Record<(typeof conversations.team)[number], ProbeFixture> = {
  threads: async (tx, teamId) => {
    await insertThread(tx, teamId);
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
};
