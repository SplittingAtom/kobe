import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { teams, threadEntries, threads, users } from "./schema/index.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-215 (CE16, CE18, CE19): pin, archive, title lock and fork provenance on `threads`. A fork
 * names its source as (team_id, forked_from_thread_id) → threads (team_id, id), so it can never
 * point into another team; deleting the source (retention, Trash purge, team deletion) only
 * clears that link, keeping the fork, its team and its fork point.
 */
const teamA = randomUUID();
const teamB = randomUUID();
const userId = randomUUID();
let app: KobeDatabase;
let owner: KobeDatabase;

beforeAll(async () => {
  owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `oa-${teamA.slice(0, 8)}`, name: "Org A" },
    { id: teamB, slug: `ob-${teamB.slice(0, 8)}`, name: "Org B" },
  ]);
  app = createDb(inject("appUrl"), { max: 4 });
  await app.db.insert(users).values({ id: userId, name: "O", email: `${userId}@org.test` });
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

/** The Postgres error a write fails with: SQLSTATE and, for key and CHECK errors, the constraint. */
async function pgError(
  promise: Promise<unknown>,
): Promise<{ code: string; constraint: string | undefined } | undefined> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (err === undefined) return undefined;
  const e = err as { cause?: { code?: string; constraint?: string } };
  if (!e.cause?.code) throw err;
  return { code: e.cause.code, constraint: e.cause.constraint };
}

const FORK_FK = { code: "23503", constraint: "threads_forked_from_fk" };
const NOT_SELF = { code: "23514", constraint: "threads_fork_not_self" };
const ENTRY_LENGTH = { code: "23514", constraint: "threads_forked_at_entry_id_length" };
/** Raised by the threads_guard_forked_from trigger (no constraint name). */
const LINK_FROZEN = { code: "428C9", constraint: undefined };

type ThreadValues = Partial<typeof threads.$inferInsert>;

/** A thread in `teamId` with a two-entry chain e1 → e2 (the leaf). */
async function newThread(teamId: string, values: ThreadValues = {}): Promise<string> {
  return withTeam(app.db, teamId, async (tx) => {
    const [row] = await tx
      .insert(threads)
      .values({ teamId, ownerUserId: userId, ...values })
      .returning({ id: threads.id });
    if (!row) throw new Error("no thread");
    await tx.insert(threadEntries).values([
      { teamId, threadId: row.id, entryId: "e1", type: "message" },
      { teamId, threadId: row.id, entryId: "e2", parentId: "e1", type: "message" },
    ]);
    await tx
      .update(threads)
      .set({ leafEntryId: "e2" })
      .where(and(eq(threads.teamId, teamId), eq(threads.id, row.id)));
    return row.id;
  });
}

const forkOf = (source: string, entry: string | null = "e1"): ThreadValues => ({
  forkedFromThreadId: source,
  forkedAtEntryId: entry,
});

async function readThread(teamId: string, id: string) {
  const [row] = await withTeam(app.db, teamId, (tx) =>
    tx
      .select()
      .from(threads)
      .where(and(eq(threads.teamId, teamId), eq(threads.id, id))),
  );
  return row;
}

describe("thread organization columns (CE18, CE19)", () => {
  it("defaults to not pinned, not archived, not a fork, title unlocked", async () => {
    const id = await newThread(teamA);
    expect(await readThread(teamA, id)).toMatchObject({
      pinnedAt: null,
      archivedAt: null,
      forkedFromThreadId: null,
      forkedAtEntryId: null,
      titleLocked: false,
    });
  });

  it("stores pin and archive times and the title lock", async () => {
    const id = await newThread(teamA);
    const at = new Date("2026-10-14T08:00:00Z");
    await withTeam(app.db, teamA, (tx) =>
      tx
        .update(threads)
        .set({ pinnedAt: at, archivedAt: at, titleLocked: true })
        .where(and(eq(threads.teamId, teamA), eq(threads.id, id))),
    );
    expect(await readThread(teamA, id)).toMatchObject({
      pinnedAt: at,
      archivedAt: at,
      titleLocked: true,
    });
  });
});

describe("fork provenance (CE16)", () => {
  it("links a fork to a thread of its own team", async () => {
    const source = await newThread(teamA);
    const fork = await newThread(teamA, forkOf(source, "e1"));
    expect(await readThread(teamA, fork)).toMatchObject({
      forkedFromThreadId: source,
      forkedAtEntryId: "e1",
    });
  });

  it("can't reference another team's thread (composite key), or a missing one", async () => {
    const theirs = await newThread(teamA);
    expect(await pgError(newThread(teamB, forkOf(theirs)))).toEqual(FORK_FK);
    expect(await pgError(newThread(teamB, forkOf(randomUUID())))).toEqual(FORK_FK);
  });

  it("sets the link at creation only: re-pointing is refused, clearing is allowed", async () => {
    const source = await newThread(teamA);
    const other = await newThread(teamA);
    const fork = await newThread(teamA, forkOf(source));
    const setLink = (to: string | null) =>
      withTeam(app.db, teamA, (tx) =>
        tx
          .update(threads)
          .set({ forkedFromThreadId: to })
          .where(and(eq(threads.teamId, teamA), eq(threads.id, fork))),
      );
    expect(await pgError(setLink(other))).toEqual(LINK_FROZEN);
    // A cycle A -> B -> A would need exactly such an update.
    expect(
      await pgError(
        withTeam(app.db, teamA, (tx) =>
          tx
            .update(threads)
            .set({ forkedFromThreadId: fork })
            .where(and(eq(threads.teamId, teamA), eq(threads.id, source))),
        ),
      ),
    ).toEqual(LINK_FROZEN);
    // Other columns of a fork stay writable, and the link can be cleared.
    await withTeam(app.db, teamA, (tx) =>
      tx
        .update(threads)
        .set({ title: "Renamed", titleLocked: true })
        .where(and(eq(threads.teamId, teamA), eq(threads.id, fork))),
    );
    expect(await pgError(setLink(null))).toBeUndefined();
    expect(await readThread(teamA, fork)).toMatchObject({ forkedFromThreadId: null });
    expect(await pgError(setLink(source))).toEqual(LINK_FROZEN);
  });

  it("refuses a thread forked from itself and a malformed fork point", async () => {
    const id = randomUUID();
    expect(await pgError(newThread(teamA, { id, ...forkOf(id) }))).toEqual(NOT_SELF);
    const source = await newThread(teamA);
    for (const bad of ["", "x".repeat(129)]) {
      expect(await pgError(newThread(teamA, forkOf(source, bad)))).toEqual(ENTRY_LENGTH);
    }
  });

  it("keeps a fork when its source is deleted: link cleared, team and fork point kept", async () => {
    const source = await newThread(teamA);
    const fork = await newThread(teamA, forkOf(source, "e2"));
    const forkOfFork = await newThread(teamA, forkOf(fork, "e1"));
    // As the retention and Trash purges do (services/server retention/purge.ts).
    await withTeam(app.db, teamA, (tx) =>
      tx.delete(threads).where(and(eq(threads.teamId, teamA), eq(threads.id, source))),
    );
    expect(await readThread(teamA, source)).toBeUndefined();
    expect(await readThread(teamA, fork)).toMatchObject({
      teamId: teamA,
      forkedFromThreadId: null,
      forkedAtEntryId: "e2",
      leafEntryId: "e2",
    });
    expect(await readThread(teamA, forkOfFork)).toMatchObject({ forkedFromThreadId: fork });
  });

  it("purges a source and its forks in one statement", async () => {
    const source = await newThread(teamA);
    const fork = await newThread(teamA, forkOf(source));
    const forkOfFork = await newThread(teamA, forkOf(fork));
    const ids = [forkOfFork, source, fork];
    await withTeam(app.db, teamA, (tx) =>
      tx.delete(threads).where(and(eq(threads.teamId, teamA), inArray(threads.id, ids))),
    );
    const left = await withTeam(app.db, teamA, (tx) =>
      tx
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.teamId, teamA), inArray(threads.id, ids))),
    );
    expect(left).toEqual([]);
  });

  it("deletes a team whose threads fork each other", async () => {
    const doomed = randomUUID();
    await owner.db
      .insert(teams)
      .values({ id: doomed, slug: `od-${doomed.slice(0, 8)}`, name: "D" });
    const source = await newThread(doomed);
    const fork = await newThread(doomed, forkOf(source));
    await newThread(doomed, forkOf(fork));
    await owner.db.delete(teams).where(eq(teams.id, doomed));
    const left = await owner.db
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.teamId, doomed));
    expect(left).toEqual([]);
  });

  it("declares the key as ON DELETE SET NULL of the link column only", async () => {
    const { rows } = await owner.db.execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'threads'::regclass AND conname = 'threads_forked_from_fk'`);
    expect(rows.map((r) => r.def)).toEqual([
      "FOREIGN KEY (team_id, forked_from_thread_id) REFERENCES threads(team_id, id) ON DELETE SET NULL (forked_from_thread_id)",
    ]);
  });
});
