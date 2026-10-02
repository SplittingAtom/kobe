import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, inject, it } from "vitest";
import { createDb } from "./client.js";
import { teamMembers, teams } from "./schema/index.js";
import { withTeam } from "./with-team.js";

const app = createDb(inject("appUrl"), { max: 1 });
afterAll(() => app.close());

describe("withTeam (Postgres)", () => {
  it("sets kobe.team_id for the transaction only", async () => {
    const teamId = randomUUID();
    const inside = await withTeam(app.db, teamId, async (tx) => {
      const r = await tx.execute<{ v: string }>(sql`SELECT current_setting('kobe.team_id') AS v`);
      return r.rows[0]?.v;
    });
    expect(inside).toBe(teamId);

    const after = await app.pool.query<{ v: string | null }>(
      `SELECT NULLIF(current_setting('kobe.team_id', true), '') AS v`,
    );
    expect(after.rows[0]?.v).toBeNull();
  });

  it("rolls back everything when the callback throws", async () => {
    const owner = createDb(inject("ownerUrl"));
    const teamId = randomUUID();
    await owner.db
      .insert(teams)
      .values({ id: teamId, slug: `r-${teamId.slice(0, 8)}`, name: "Rollback" });
    await owner.close();

    await expect(
      withTeam(app.db, teamId, async (tx) => {
        await tx.insert(teamMembers).values({ teamId, userId: randomUUID(), role: "member" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const remaining = await withTeam(app.db, teamId, (tx) => tx.select().from(teamMembers));
    expect(remaining).toEqual([]);
  });
});
