import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { teams, teamWebSearch, users, webSearchSettings } from "./schema/index.js";
import { withTeam } from "./with-team.js";

/** KOBE-113: the install web-search provider (sealed key) and the team opt-in. */
let app: KobeDatabase;
const teamA = randomUUID();
const teamB = randomUUID();
const userId = randomUUID();

const settings = (over: Partial<typeof webSearchSettings.$inferInsert> = {}) => ({
  provider: "brave" as const,
  sealed: "e1.kid.a.b.c.d.e.f",
  keyId: "kid",
  hint: "••••1234",
  updatedBy: userId,
  ...over,
});
const pgCode = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code;

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `wa-${teamA.slice(0, 8)}`, name: "WS A" },
    { id: teamB, slug: `wb-${teamB.slice(0, 8)}`, name: "WS B" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: userId, name: "W", email: `${userId}@w.test` });
});
afterAll(() => app.close());

describe("web_search_settings", () => {
  it.each([
    ["plaintext", "sk-live-abcdef"],
    ["empty", ""],
    ["wrong version prefix", "e2.kid.x"],
  ])("refuses a key that is not envelope text (%s)", async (_n, sealed) => {
    await expect(app.db.insert(webSearchSettings).values(settings({ sealed }))).rejects.toSatisfy(
      (e) => pgCode(e) === "23514",
    );
  });

  it("refuses an unknown provider", async () => {
    await expect(
      app.db.insert(webSearchSettings).values(settings({ provider: "bing" as "brave" })),
    ).rejects.toSatisfy((e) => pgCode(e) === "23514");
  });

  it("holds at most one row", async () => {
    await app.db.insert(webSearchSettings).values(settings());
    await expect(app.db.insert(webSearchSettings).values(settings())).rejects.toSatisfy(
      (e) => pgCode(e) === "23505",
    );
    await expect(app.db.insert(webSearchSettings).values(settings({ id: 2 }))).rejects.toSatisfy(
      (e) => pgCode(e) === "23514",
    );
    await app.db.delete(webSearchSettings);
  });
});

describe("team_web_search", () => {
  it("is invisible and unwritable outside its team", async () => {
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(teamWebSearch).values({ teamId: teamA, enabledBy: userId }),
    );
    expect(await withTeam(app.db, teamB, (tx) => tx.select().from(teamWebSearch))).toEqual([]);
    await expect(
      withTeam(app.db, teamB, (tx) =>
        tx.insert(teamWebSearch).values({ teamId: teamA, enabledBy: userId }),
      ),
    ).rejects.toSatisfy((e) => pgCode(e) === "42501");
    expect(await withTeam(app.db, teamA, (tx) => tx.select().from(teamWebSearch))).toHaveLength(1);
  });

  it("is one row per team", async () => {
    await expect(
      withTeam(app.db, teamA, (tx) =>
        tx.insert(teamWebSearch).values({ teamId: teamA, enabledBy: userId }),
      ),
    ).rejects.toSatisfy((e) => pgCode(e) === "23505");
  });
});
