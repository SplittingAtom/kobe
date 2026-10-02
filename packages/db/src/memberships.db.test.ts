import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb } from "./client.js";
import { getMembership, listMemberships } from "./memberships.js";
import { teamMembers, teams, users } from "./schema/index.js";
import { withTeam } from "./with-team.js";

const app = createDb(inject("appUrl"), { max: 1 });
afterAll(() => app.close());

const user = randomUUID();
const other = randomUUID();
const [alpha, beta, gamma] = [randomUUID(), randomUUID(), randomUUID()];

beforeAll(async () => {
  await app.db.insert(users).values([
    { id: user, name: "U", email: `${user}@m.test` },
    { id: other, name: "O", email: `${other}@m.test` },
  ]);
  await app.db.insert(teams).values([
    { id: alpha, slug: `alpha-${alpha.slice(0, 8)}`, name: "Alpha" },
    { id: beta, slug: `beta-${beta.slice(0, 8)}`, name: "Beta" },
    { id: gamma, slug: `gamma-${gamma.slice(0, 8)}`, name: "Gamma" },
  ]);
  await withTeam(app.db, alpha, (tx) =>
    tx.insert(teamMembers).values([
      { teamId: alpha, userId: user, role: "builder" },
      { teamId: alpha, userId: other, role: "team_admin" },
    ]),
  );
  await withTeam(app.db, gamma, (tx) =>
    tx.insert(teamMembers).values({ teamId: gamma, userId: user, role: "team_admin" }),
  );
});

describe("listMemberships (team_members stays behind RLS)", () => {
  it("lists only the user's teams, with their role, sorted by name", async () => {
    const mine = await listMemberships(app.db, user);
    expect(mine.map((m) => [m.name, m.role])).toEqual([
      ["Alpha", "builder"],
      ["Gamma", "team_admin"],
    ]);
    expect(mine[0]).toMatchObject({ teamId: alpha, slug: `alpha-${alpha.slice(0, 8)}` });
  });

  it("returns an empty list for a user without teams", async () => {
    expect(await listMemberships(app.db, randomUUID())).toEqual([]);
  });

  it("leaves no team setting behind on the pooled connection", async () => {
    await listMemberships(app.db, user);
    const r = await app.pool.query(`SELECT NULLIF(current_setting('kobe.team_id', true), '') AS v`);
    expect(r.rows[0]).toEqual({ v: null });
  });

  it("refuses to run inside a team transaction (it would switch teams)", async () => {
    await withTeam(app.db, alpha, async (tx) => {
      await expect(listMemberships(tx, user)).rejects.toThrow(/inside a team transaction/);
      const r = await tx.execute<{ v: string }>(sql`SELECT current_setting('kobe.team_id') AS v`);
      expect(r.rows[0]?.v).toBe(alpha);
    });
  });

  it("rejects a non-UUID user id", async () => {
    await expect(listMemberships(app.db, "nope")).rejects.toThrow(/UUID/);
  });
});

describe("getMembership", () => {
  it("returns the role in that team, or null", async () => {
    expect(await getMembership(app.db, alpha, user)).toBe("builder");
    expect(await getMembership(app.db, gamma, user)).toBe("team_admin");
    expect(await getMembership(app.db, beta, user)).toBeNull();
    expect(await getMembership(app.db, randomUUID(), user)).toBeNull();
  });
});
