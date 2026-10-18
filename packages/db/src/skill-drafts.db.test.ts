import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import {
  SKILL_DRAFT_MAX_BYTES,
  skillDraftFiles,
  skillDrafts,
  teams,
  users,
} from "./schema/index.js";
import { withTeam } from "./with-team.js";

/**
 * Workbench drafts in the database (KOBE-320, SK11): one content column per file, the draft's
 * size and file count kept by the database from its files (so the 5 MiB cap binds every writer),
 * files that never move, and a draft's files gone with it. Team isolation is the probe suite's.
 */
const teamA = randomUUID();
const teamB = randomUUID();
const alice = randomUUID();
let app: KobeDatabase;
let owner: KobeDatabase;

beforeAll(async () => {
  owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `dr-a-${teamA.slice(0, 8)}`, name: "Drafts A" },
    { id: teamB, slug: `dr-b-${teamB.slice(0, 8)}`, name: "Drafts B" },
  ]);
  await owner.db.insert(users).values({ id: alice, name: "Alice", email: `${alice}@dr.test` });
  app = createDb(inject("appUrl"));
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (err === undefined) return undefined;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.cause?.code ?? e.code ?? String(err);
}

async function newDraft(teamId = teamA, name = "demo"): Promise<string> {
  return withTeam(app.db, teamId, async (tx) => {
    const [row] = await tx
      .insert(skillDrafts)
      .values({ teamId, ownerUserId: alice, updatedBy: alice, name })
      .returning({ id: skillDrafts.id });
    if (!row) throw new Error("no draft");
    return row.id;
  });
}

async function draftSize(teamId: string, id: string) {
  return withTeam(app.db, teamId, async (tx) => {
    const [row] = await tx
      .select({ size: skillDrafts.sizeBytes, files: skillDrafts.fileCount })
      .from(skillDrafts)
      .where(and(eq(skillDrafts.teamId, teamId), eq(skillDrafts.id, id)));
    return row;
  });
}

describe("skill_drafts", () => {
  it("tracks size and file count from the files, on insert, rewrite and delete", async () => {
    const id = await newDraft();
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(skillDraftFiles).values([
        { teamId: teamA, draftId: id, path: "SKILL.md", textContent: "héllo", size: 6 },
        { teamId: teamA, draftId: id, path: "a.bin", bytes: Buffer.from([0, 1]), size: 2 },
      ]),
    );
    expect(await draftSize(teamA, id)).toEqual({ size: 8, files: 2 });
    await withTeam(app.db, teamA, (tx) =>
      tx
        .update(skillDraftFiles)
        .set({ textContent: "hi", size: 2 })
        .where(and(eq(skillDraftFiles.draftId, id), eq(skillDraftFiles.path, "SKILL.md"))),
    );
    expect(await draftSize(teamA, id)).toEqual({ size: 4, files: 2 });
    await withTeam(app.db, teamA, (tx) =>
      tx
        .delete(skillDraftFiles)
        .where(and(eq(skillDraftFiles.draftId, id), eq(skillDraftFiles.path, "a.bin"))),
    );
    expect(await draftSize(teamA, id)).toEqual({ size: 2, files: 1 });
  });

  it("caps a whole draft at 5 MiB, whoever writes", async () => {
    const id = await newDraft();
    const half = Buffer.alloc(SKILL_DRAFT_MAX_BYTES / 2 + 1, 1);
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(skillDraftFiles).values({
        teamId: teamA,
        draftId: id,
        path: "one.bin",
        bytes: half,
        size: half.length,
      }),
    );
    const state = await sqlState(
      withTeam(app.db, teamA, (tx) =>
        tx.insert(skillDraftFiles).values({
          teamId: teamA,
          draftId: id,
          path: "two.bin",
          bytes: half,
          size: half.length,
        }),
      ),
    );
    expect(state).toBe("23514");
    expect(await draftSize(teamA, id)).toEqual({ size: half.length, files: 1 });
  });

  it("refuses a file with both or neither content, a wrong size, or an empty path", async () => {
    const id = await newDraft();
    const insert = (values: Partial<typeof skillDraftFiles.$inferInsert>) =>
      sqlState(
        withTeam(app.db, teamA, (tx) =>
          tx
            .insert(skillDraftFiles)
            .values({ teamId: teamA, draftId: id, path: "x", size: 1, ...values }),
        ),
      );
    expect(await insert({ textContent: "x", bytes: Buffer.from([1]) })).toBe("23514");
    expect(await insert({})).toBe("23514");
    expect(await insert({ textContent: "xy" })).toBe("23514");
    expect(await insert({ path: "", textContent: "x" })).toBe("23514");
    expect(await insert({ path: "a".repeat(241), textContent: "x" })).toBe("23514");
  });

  it("keeps size and file count to the database, and files in their draft", async () => {
    const id = await newDraft();
    const other = await newDraft();
    expect(
      await sqlState(
        withTeam(app.db, teamA, (tx) =>
          tx.insert(skillDrafts).values({
            teamId: teamA,
            ownerUserId: alice,
            updatedBy: alice,
            name: "sized",
            sizeBytes: 10,
          }),
        ),
      ),
    ).toBe("55000");
    expect(
      await sqlState(
        withTeam(app.db, teamA, (tx) =>
          tx.update(skillDrafts).set({ sizeBytes: 0, fileCount: 3 }).where(eq(skillDrafts.id, id)),
        ),
      ),
    ).toBe("55000");
    await withTeam(app.db, teamA, (tx) =>
      tx
        .insert(skillDraftFiles)
        .values({ teamId: teamA, draftId: id, path: "SKILL.md", textContent: "x", size: 1 }),
    );
    expect(
      await sqlState(
        withTeam(app.db, teamA, (tx) =>
          tx.update(skillDraftFiles).set({ draftId: other }).where(eq(skillDraftFiles.draftId, id)),
        ),
      ),
    ).toBe("55000");
    // Other columns change freely.
    await withTeam(app.db, teamA, (tx) =>
      tx
        .update(skillDrafts)
        .set({ shared: true, rev: sql`${skillDrafts.rev} + 1` })
        .where(eq(skillDrafts.id, id)),
    );
  });

  it("deletes a draft with its files", async () => {
    const id = await newDraft();
    await withTeam(app.db, teamA, (tx) =>
      tx
        .insert(skillDraftFiles)
        .values({ teamId: teamA, draftId: id, path: "SKILL.md", textContent: "x", size: 1 }),
    );
    await withTeam(app.db, teamA, (tx) => tx.delete(skillDrafts).where(eq(skillDrafts.id, id)));
    const left = await withTeam(app.db, teamA, (tx) =>
      tx.select().from(skillDraftFiles).where(eq(skillDraftFiles.draftId, id)),
    );
    expect(left).toHaveLength(0);
  });

  it("refuses a file under another team's draft", async () => {
    const id = await newDraft(teamB);
    const state = await sqlState(
      withTeam(app.db, teamA, (tx) =>
        tx
          .insert(skillDraftFiles)
          .values({ teamId: teamA, draftId: id, path: "SKILL.md", textContent: "x", size: 1 }),
      ),
    );
    // The composite key: (team A, B's draft id) names no draft.
    expect(state).toBe("23503");
  });

  it("refuses a malformed name or start", async () => {
    const bad = (values: Partial<typeof skillDrafts.$inferInsert>) =>
      sqlState(
        withTeam(app.db, teamA, (tx) =>
          tx
            .insert(skillDrafts)
            .values({ teamId: teamA, ownerUserId: alice, updatedBy: alice, name: "ok", ...values }),
        ),
      );
    expect(await bad({ name: "Not-OK" })).toBe("23514");
    expect(await bad({ startedFrom: "nowhere" as never })).toBe("23514");
    expect(await bad({ parentRef: [] as never })).toBe("23514");
  });
});
