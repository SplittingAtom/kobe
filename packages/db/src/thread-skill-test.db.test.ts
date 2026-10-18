import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { skillDrafts, teams, threads, users } from "./schema/index.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-323 (SK13): a Workbench test chat is an ordinary thread marked `skill_test`, linked to its
 * draft by (team_id, skill_draft_id) → skill_drafts, so it can never name another team's draft.
 * Deleting the draft only clears the link: the thread stays a test chat (its runs then refuse).
 */
const teamA = randomUUID();
const teamB = randomUUID();
const userId = randomUUID();
let app: KobeDatabase;
let owner: KobeDatabase;

beforeAll(async () => {
  owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `wa-${teamA.slice(0, 8)}`, name: "Bench A" },
    { id: teamB, slug: `wb-${teamB.slice(0, 8)}`, name: "Bench B" },
  ]);
  app = createDb(inject("appUrl"), { max: 4 });
  await app.db.insert(users).values({ id: userId, name: "W", email: `${userId}@bench.test` });
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

async function pgError(promise: Promise<unknown>) {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (err === undefined) return undefined;
  const e = err as { cause?: { code?: string; constraint?: string } };
  if (!e.cause?.code) throw err;
  return { code: e.cause.code, constraint: e.cause.constraint };
}

const draftIn = (teamId: string) =>
  withTeam(app.db, teamId, async (tx) => {
    const [row] = await tx
      .insert(skillDrafts)
      .values({ teamId, ownerUserId: userId, updatedBy: userId, name: "bench-skill" })
      .returning({ id: skillDrafts.id });
    if (!row) throw new Error("no draft");
    return row.id;
  });

const threadIn = (teamId: string, values: Partial<typeof threads.$inferInsert>) =>
  withTeam(app.db, teamId, async (tx) => {
    const [row] = await tx
      .insert(threads)
      .values({ teamId, ownerUserId: userId, ...values })
      .returning();
    if (!row) throw new Error("no thread");
    return row;
  });

describe("threads.skill_test and skill_draft_id (KOBE-323)", () => {
  it("defaults to an ordinary thread", async () => {
    const t = await threadIn(teamA, {});
    expect([t.skillTest, t.skillDraftId]).toEqual([false, null]);
  });

  it("links a test chat to a draft of its own team only", async () => {
    const draft = await draftIn(teamA);
    const t = await threadIn(teamA, { skillTest: true, skillDraftId: draft });
    expect([t.skillTest, t.skillDraftId]).toEqual([true, draft]);
    const other = await draftIn(teamB);
    expect(await pgError(threadIn(teamA, { skillTest: true, skillDraftId: other }))).toEqual({
      code: "23503",
      constraint: "threads_skill_draft_fk",
    });
  });

  it("names a draft only on a test chat, and never on a builder test thread", async () => {
    const draft = await draftIn(teamA);
    expect(await pgError(threadIn(teamA, { skillDraftId: draft }))).toEqual({
      code: "23514",
      constraint: "threads_skill_draft_test",
    });
    expect(await pgError(threadIn(teamA, { skillTest: true, isTest: true }))).toMatchObject({
      code: "23514",
    });
  });

  it("keeps the test chat when its draft is deleted, with the link cleared", async () => {
    const draft = await draftIn(teamA);
    const t = await threadIn(teamA, { skillTest: true, skillDraftId: draft });
    await withTeam(app.db, teamA, (tx) => tx.delete(skillDrafts).where(eq(skillDrafts.id, draft)));
    const [after] = await withTeam(app.db, teamA, (tx) =>
      tx.select().from(threads).where(eq(threads.id, t.id)),
    );
    expect([after?.skillTest, after?.skillDraftId, after?.teamId]).toEqual([true, null, teamA]);
  });
});
