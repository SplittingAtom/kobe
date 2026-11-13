import { randomUUID } from "node:crypto";
import type { KobeTx } from "../../client.js";
import {
  portableMemoryItemVersions,
  portableMemoryItems,
  runMemoryItems,
  runPortableMemoryItems,
  runSiteMemoryItems,
  runs,
  semanticMemoryItemVersions,
  semanticMemoryItems,
  memoryReminders,
  memoryStewards,
  siteMemoryItemVersions,
  siteMemoryItems,
  teamMembers,
  threads,
  users,
} from "../../schema/index.js";
import type { memory } from "../../tenancy/memory.js";
import type { ProbeFixture } from "./types.js";

async function insertUser(tx: KobeTx): Promise<string> {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
  return userId;
}

/** A thread of `userId` with one run, for run records to hang off. */
async function insertRun(tx: KobeTx, teamId: string, userId: string): Promise<string> {
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
  return run.id;
}

/** A personal Workspace item with its first version (one transaction: deferred version key). */
async function insertItem(tx: KobeTx, teamId: string) {
  const userId = await insertUser(tx);
  const [item] = await tx
    .insert(semanticMemoryItems)
    .values({ teamId, scope: "user", ownerUserId: userId, kind: "preference" })
    .returning({ id: semanticMemoryItems.id });
  if (!item) throw new Error("probe: semantic memory item insert returned nothing");
  await tx.insert(semanticMemoryItemVersions).values({
    teamId,
    itemId: item.id,
    version: 1,
    statement: "Prefers metric units",
    actorKind: "user",
    actorUserId: userId,
  });
  return { itemId: item.id, userId };
}

export const memoryFixtures: Record<(typeof memory.team)[number], ProbeFixture> = {
  semantic_memory_items: async (tx, teamId) => {
    await insertItem(tx, teamId);
  },
  semantic_memory_item_versions: async (tx, teamId) => {
    await insertItem(tx, teamId);
  },
  run_memory_items: async (tx, teamId) => {
    const { itemId, userId } = await insertItem(tx, teamId);
    const runId = await insertRun(tx, teamId, userId);
    await tx.insert(runMemoryItems).values({ teamId, runId, itemId, version: 1 });
  },
  run_portable_memory_items: async (tx, teamId) => {
    const userId = await insertUser(tx);
    const [item] = await tx
      .insert(portableMemoryItems)
      .values({ ownerUserId: userId, kind: "preference" })
      .returning({ id: portableMemoryItems.id });
    if (!item) throw new Error("probe: portable item insert returned nothing");
    await tx.insert(portableMemoryItemVersions).values({
      itemId: item.id,
      version: 1,
      statement: "Prefers short answers",
      actorKind: "user",
      actorUserId: userId,
    });
    const runId = await insertRun(tx, teamId, userId);
    await tx.insert(runPortableMemoryItems).values({ teamId, runId, itemId: item.id, version: 1 });
  },
  run_site_memory_items: async (tx, teamId) => {
    const userId = await insertUser(tx);
    const [item] = await tx
      .insert(siteMemoryItems)
      .values({ kind: "convention", policy: true })
      .returning({ id: siteMemoryItems.id });
    if (!item) throw new Error("probe: site item insert returned nothing");
    await tx.insert(siteMemoryItemVersions).values({
      itemId: item.id,
      version: 1,
      statement: "Never share customer names",
      actorKind: "user",
      actorUserId: userId,
    });
    const runId = await insertRun(tx, teamId, userId);
    await tx.insert(runSiteMemoryItems).values({ teamId, runId, itemId: item.id, version: 1 });
  },
  memory_stewards: async (tx, teamId) => {
    const userId = await insertUser(tx);
    await tx.insert(teamMembers).values({ teamId, userId, role: "contributor" });
    await tx.insert(memoryStewards).values({ teamId, userId, grantedBy: userId });
  },
  memory_reminders: async (tx, teamId) => {
    const userId = await insertUser(tx);
    await tx.insert(teamMembers).values({ teamId, userId, role: "team_admin" });
    await tx.insert(memoryReminders).values({
      teamId,
      objectId: randomUUID(),
      relatedKind: "memory.proposal.received",
      userId,
      dueAt: new Date(Date.now() + 7 * 86_400_000),
    });
  },
};
