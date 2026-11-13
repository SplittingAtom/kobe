import { randomUUID } from "node:crypto";
import type { KobeTx } from "../../client.js";
import {
  runMemoryItems,
  runs,
  semanticMemoryItemVersions,
  semanticMemoryItems,
  threads,
  users,
} from "../../schema/index.js";
import type { memory } from "../../tenancy/memory.js";
import type { ProbeFixture } from "./types.js";

/** A personal Workspace item with its first version; versions and run records need one. */
async function insertItem(tx: KobeTx, teamId: string) {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
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
    await tx.insert(runMemoryItems).values({ teamId, runId: run.id, itemId, version: 1 });
  },
};
