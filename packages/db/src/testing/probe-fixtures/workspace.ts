import { randomUUID } from "node:crypto";
import type { KobeTx } from "../../client.js";
import {
  artifactVersions,
  artifacts,
  files,
  runs,
  teamStorageQuotas,
  threads,
  users,
} from "../../schema/index.js";
import type { workspace } from "../../tenancy/workspace.js";
import type { ProbeFixture } from "./types.js";

/** A thread, its owner and a run, for the artifact rows to hang off. */
async function insertThreadAndRun(tx: KobeTx, teamId: string) {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
  const [thread] = await tx
    .insert(threads)
    .values({ teamId, ownerUserId: userId, title: "Probe" })
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

async function insertArtifact(tx: KobeTx, teamId: string) {
  const { userId, threadId, runId } = await insertThreadAndRun(tx, teamId);
  const [row] = await tx
    .insert(artifacts)
    .values({ teamId, threadId, createdBy: userId, kind: "markdown", title: "Probe" })
    .returning({ id: artifacts.id });
  if (!row) throw new Error("probe: artifact insert returned nothing");
  return { artifactId: row.id, threadId, runId };
}

export const workspaceFixtures: Record<(typeof workspace.team)[number], ProbeFixture> = {
  artifacts: async (tx, teamId) => {
    await insertArtifact(tx, teamId);
  },
  artifact_versions: async (tx, teamId) => {
    const { artifactId, threadId, runId } = await insertArtifact(tx, teamId);
    await tx.insert(artifactVersions).values({
      teamId,
      artifactId,
      version: 1,
      threadId,
      blobRef: `teams/${teamId}/threads/${threadId}/artifacts/${artifactId}/v1`,
      sizeBytes: 5,
      sha256: "0".repeat(64),
      runId,
      toolCallId: "probe",
    });
  },
  files: async (tx, teamId) => {
    const { userId, threadId } = await insertThreadAndRun(tx, teamId);
    await tx.insert(files).values({
      teamId,
      userId,
      threadId,
      kind: "upload",
      name: "probe.txt",
      sizeBytes: 5,
      sha256: "0".repeat(64),
      mimeType: "text/plain",
      blobRef: `teams/${teamId}/threads/${threadId}/files/probe`,
    });
  },
  team_storage_quotas: async (tx, teamId) => {
    const { userId } = await insertThreadAndRun(tx, teamId);
    await tx.insert(teamStorageQuotas).values({ teamId, maxBytes: 1024, updatedBy: userId });
  },
};
