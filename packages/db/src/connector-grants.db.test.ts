import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { connectorGrants, connectors, teams, users } from "./schema/index.js";
import { withTeam } from "./with-team.js";

/** KOBE-108: per-user connector grants, a team table whose secret is stored sealed. */
let app: KobeDatabase;
const teamA = randomUUID();
const teamB = randomUUID();
const userId = randomUUID();
let connectorId: string;

const row = (teamId: string, sealed = "e1.kid.a.b.c.d.e.f") => ({
  teamId,
  userId,
  connectorId,
  sealed,
  keyId: "kid",
  hint: "••••1234",
});
const pgCode = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code;

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `ga-${teamA.slice(0, 8)}`, name: "Grants A" },
    { id: teamB, slug: `gb-${teamB.slice(0, 8)}`, name: "Grants B" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: userId, name: "G", email: `${userId}@g.test` });
  const [c] = await app.db
    .insert(connectors)
    .values({ name: `grants-${randomUUID().slice(0, 8)}`, url: "https://mcp.example.com/mcp" })
    .returning({ id: connectors.id });
  if (!c) throw new Error("connector insert returned nothing");
  connectorId = c.id;
});
afterAll(() => app.close());

describe("connector_grants", () => {
  it("is invisible and unwritable outside its team", async () => {
    await withTeam(app.db, teamA, (tx) => tx.insert(connectorGrants).values(row(teamA)));
    const fromB = await withTeam(app.db, teamB, (tx) => tx.select().from(connectorGrants));
    expect(fromB).toEqual([]);
    await expect(
      withTeam(app.db, teamB, (tx) => tx.insert(connectorGrants).values(row(teamA))),
    ).rejects.toSatisfy((e) => pgCode(e) === "42501");
    const del = await withTeam(app.db, teamB, (tx) =>
      tx.delete(connectorGrants).where(eq(connectorGrants.connectorId, connectorId)).returning(),
    );
    expect(del).toEqual([]);
    const fromA = await withTeam(app.db, teamA, (tx) =>
      tx
        .select()
        .from(connectorGrants)
        .where(and(eq(connectorGrants.userId, userId))),
    );
    expect(fromA).toHaveLength(1);
  });

  it("allows one grant per (team, user, connector)", async () => {
    await expect(
      withTeam(app.db, teamA, (tx) => tx.insert(connectorGrants).values(row(teamA))),
    ).rejects.toSatisfy((e) => pgCode(e) === "23505");
  });

  it.each([
    ["plaintext", "sk-live-abcdef"],
    ["empty", ""],
    ["wrong version prefix", "e2.kid.x"],
  ])("refuses a secret that is not envelope text (%s)", async (_n, sealed) => {
    await expect(
      withTeam(app.db, teamB, (tx) => tx.insert(connectorGrants).values(row(teamB, sealed))),
    ).rejects.toSatisfy((e) => pgCode(e) === "23514");
  });

  it("accepts the oauth kind with an expiry, and refuses an unknown kind", async () => {
    const other = randomUUID();
    await app.db.insert(users).values({ id: other, name: "O", email: `${other}@g.test` });
    const oauth = { ...row(teamA), userId: other, kind: "oauth" as const };
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(connectorGrants).values({ ...oauth, expiresAt: new Date(Date.now() + 3600_000) }),
    );
    const [stored] = await withTeam(app.db, teamA, (tx) =>
      tx.select().from(connectorGrants).where(eq(connectorGrants.userId, other)),
    );
    expect(stored?.kind).toBe("oauth");
    expect(stored?.expiresAt).toBeInstanceOf(Date);
    await expect(
      withTeam(app.db, teamA, (tx) =>
        tx
          .insert(connectorGrants)
          .values({ ...oauth, userId: userId, connectorId, kind: "saml" as never }),
      ),
    ).rejects.toSatisfy((e) => pgCode(e) === "23514");
  });

  it("has no break-glass policy", async () => {
    const owner = createDb(inject("ownerUrl"));
    const { rows } = await owner.pool.query(
      "SELECT policyname FROM pg_policies WHERE tablename = 'connector_grants'",
    );
    await owner.close();
    expect(rows.map((r: { policyname: string }) => r.policyname)).toEqual(["team_isolation"]);
  });
});
