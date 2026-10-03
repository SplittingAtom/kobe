import { randomUUID } from "node:crypto";
import type { KobeTx } from "../../client.js";
import {
  runs,
  sandboxCommands,
  sandboxConnections,
  sandboxRunLeases,
  sandboxes,
  threads,
  users,
  workspaceBlobs,
  workspaceFiles,
  workspaceSync,
} from "../../schema/index.js";
import type { sandbox } from "../../tenancy/sandbox.js";
import type { ProbeFixture } from "./types.js";

const PROBE_SHA = "b".repeat(64);

async function insertRun(
  tx: KobeTx,
  teamId: string,
): Promise<{ userId: string; threadId: string; runId: string }> {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
  const [thread] = await tx
    .insert(threads)
    .values({ teamId, ownerUserId: userId })
    .returning({ id: threads.id });
  if (!thread) throw new Error("probe: thread insert returned nothing");
  const [run] = await tx
    .insert(runs)
    .values({
      teamId,
      threadId: thread.id,
      trigger: "user",
      status: "running",
      startedAt: new Date(),
    })
    .returning({ id: runs.id });
  if (!run) throw new Error("probe: run insert returned nothing");
  return { userId, threadId: thread.id, runId: run.id };
}

export const sandboxFixtures: Record<(typeof sandbox.team)[number], ProbeFixture> = {
  sandbox_connections: async (tx, teamId) => {
    const { userId } = await insertRun(tx, teamId);
    await tx.insert(sandboxConnections).values({
      teamId,
      userId,
      sandboxId: randomUUID(),
      connectionId: randomUUID(),
      replicaId: "probe",
    });
  },
  sandbox_commands: async (tx, teamId) => {
    const { userId, threadId, runId } = await insertRun(tx, teamId);
    await tx.insert(sandboxCommands).values({
      teamId,
      userId,
      threadId,
      runId,
      kind: "run.steer",
      frame: { probe: true },
      requesterReplica: "probe",
      expiresAt: new Date(Date.now() + 60_000),
    });
  },
  sandbox_run_leases: async (tx, teamId) => {
    const { userId, threadId, runId } = await insertRun(tx, teamId);
    await tx
      .insert(sandboxRunLeases)
      .values({ teamId, runId, userId, threadId, sandboxId: randomUUID() });
  },
  sandboxes: async (tx, teamId) => {
    const { userId } = await insertRun(tx, teamId);
    await tx
      .insert(sandboxes)
      .values({ teamId, userId, sandboxId: randomUUID(), state: "hibernated" });
  },
  workspace_sync: async (tx, teamId) => {
    const { userId } = await insertRun(tx, teamId);
    await tx
      .insert(workspaceSync)
      .values({ teamId, userId, headRev: 1, liveFiles: 1, liveBytes: 3 });
  },
  workspace_files: async (tx, teamId) => {
    const { userId } = await insertRun(tx, teamId);
    await tx.insert(workspaceFiles).values({
      teamId,
      userId,
      path: "probe.txt",
      rev: 1,
      sha256: PROBE_SHA,
      blobKey: `teams/${teamId}/users/${userId}/workspace/${PROBE_SHA}`,
      size: 3,
      mtimeMs: 0,
      origin: "sandbox",
    });
  },
  workspace_blobs: async (tx, teamId) => {
    const { userId } = await insertRun(tx, teamId);
    await tx.insert(workspaceBlobs).values({ teamId, userId, sha256: PROBE_SHA, size: 3 });
  },
};
