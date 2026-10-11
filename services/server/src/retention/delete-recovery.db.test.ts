import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithAuditContext } from "../audit/context.js";
import { createTeamWithAdmin } from "../teams/members.js";
import { openHarness, type Harness } from "../testing/harness.js";
import { MemoryObjects } from "../testing/memory-objects.js";
import type { BlobStore } from "./blobs.js";
import { deleteReleasedBlobs } from "./blobs.js";
import { DeleteAbortedError } from "./bounded-delete.js";

/** KOBE-243: after a timed-out delete, rows of the objects that did go are dropped. */
let h: Harness;
let team = "";
let user = "";
const memory = new MemoryObjects();

/** Deletes the first key at once, then hangs until aborted (reporting what it removed). */
function partialStore(): BlobStore {
  const objects = Object.assign(Object.create(memory) as MemoryObjects, {
    delete: (keys: readonly string[], o?: { signal?: AbortSignal }) =>
      new Promise<void>((_res, rej) => {
        const first = keys.slice(0, 1);
        memory.deleted.push(...first);
        o?.signal?.addEventListener("abort", () =>
          rej(Object.assign(new Error("aborted"), { deleted: first })),
        );
      }),
  });
  return { objects, prefix: "kobe/", deleteTimeoutMs: 50 };
}

beforeAll(async () => {
  h = await openHarness({ blobs: { objects: memory, prefix: "kobe/" } });
  user = await h.createUser("owner@recovery.test", "owner");
  team = (
    await runWithAuditContext(
      { actor: { kind: "user", id: user }, ip: null, userAgent: null },
      () => createTeamWithAdmin(h.deps.database.db, { slug: "recovery", name: "recovery" }, user),
    )
  ).id;
}, 120_000);
afterAll(() => h?.close());
beforeEach(async () => {
  await h.admin.query(`DELETE FROM retention_blob_deletions`);
});

describe("queue rows after a timed-out delete", () => {
  it("drops the rows of deleted keys, keeps the rest for the retry", async () => {
    const thread = randomUUID();
    const keys = [1, 2].map((i) => `kobe/teams/${team}/threads/${thread}/entries/${i}`);
    for (const key of keys) {
      await h.admin.query(
        `INSERT INTO retention_blob_deletions (team_id, thread_id, key, owner_user_id) VALUES ($1, $2, $3, $4)`,
        [team, thread, key, user],
      );
    }
    const record = () => Promise.resolve();
    const err = await deleteReleasedBlobs(h.deps.database.db, team, partialStore(), record).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DeleteAbortedError);
    const left = await h.admin.query<{ key: string }>(
      `SELECT key FROM retention_blob_deletions WHERE team_id = $1`,
      [team],
    );
    expect(left.rows.map((r) => r.key)).toEqual([keys[1]]);
  });
});
