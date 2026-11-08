import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import {
  schedules,
  siteAgentRoster,
  siteAgents,
  teamAgentRoster,
  teams,
  users,
} from "./schema/index.js";
import { withTeam } from "./with-team.js";

/**
 * Agent rosters (KOBE-565, spec agents-roster AR3/AR8/AR11): the team roster behind team RLS,
 * the site roster site-wide, site_agents.bound_team_id on personal rows only, and the
 * agent_unavailable schedule pause. Runs as the app role.
 */
const teamA = randomUUID();
const teamB = randomUUID();
const alice = randomUUID();
let app: KobeDatabase;

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `ro-a-${teamA.slice(0, 8)}`, name: "Roster A" },
    { id: teamB, slug: `ro-b-${teamB.slice(0, 8)}`, name: "Roster B" },
  ]);
  await owner.db.insert(users).values({ id: alice, name: "Alice", email: `${alice}@roster.test` });
  await owner.close();
  app = createDb(inject("appUrl"));
});

afterAll(() => app.close());

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (err === undefined) return undefined;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.cause?.code ?? e.code ?? String(err);
}

const teamEntry = (
  teamId: string,
  extra: Partial<typeof teamAgentRoster.$inferInsert> = {},
  asTeam = teamId,
) =>
  withTeam(app.db, asTeam, (tx) =>
    tx
      .insert(teamAgentRoster)
      .values({ teamId, siteAgentId: randomUUID(), assignedBy: alice, ...extra })
      .returning(),
  );

const siteEntry = (extra: Partial<typeof siteAgentRoster.$inferInsert> = {}) =>
  app.db
    .insert(siteAgentRoster)
    .values({ siteAgentId: randomUUID(), assignedBy: alice, ...extra })
    .returning();

describe("team_agent_roster", () => {
  it("applies defaults and stays invisible to another team and outside withTeam", async () => {
    const [made] = await teamEntry(teamA);
    expect(made).toMatchObject({
      state: "active",
      versionRule: "latest",
      pinnedVersion: null,
      decidedBy: null,
      decidedAt: null,
      note: null,
      removedAt: null,
    });
    expect(made?.assignedAt).toBeInstanceOf(Date);
    expect(await withTeam(app.db, teamB, (tx) => tx.select().from(teamAgentRoster))).toEqual([]);
    expect(await app.db.select().from(teamAgentRoster)).toEqual([]);
  });

  it("refuses rows for another team (RLS WITH CHECK)", async () => {
    expect(await sqlState(teamEntry(teamA, {}, teamB))).toBe("42501");
  });

  it("keeps one entry per (team, agent) but lets other teams list the same agent", async () => {
    const siteAgentId = randomUUID();
    await teamEntry(teamA, { siteAgentId });
    expect(await sqlState(teamEntry(teamA, { siteAgentId }))).toBe("23505");
    await expect(teamEntry(teamB, { siteAgentId })).resolves.toHaveLength(1);
  });

  it("accepts every state and refuses an unknown one", async () => {
    for (const state of ["proposed", "active", "removed", "suspended"] as const) {
      await expect(teamEntry(teamA, { state })).resolves.toHaveLength(1);
    }
    expect(await sqlState(teamEntry(teamA, { state: "gone" as "active" }))).toBe("23514");
  });

  it("ties pinned_version to the pinned rule", async () => {
    await expect(
      teamEntry(teamA, { versionRule: "pinned", pinnedVersion: 3 }),
    ).resolves.toHaveLength(1);
    expect(await sqlState(teamEntry(teamA, { versionRule: "pinned" }))).toBe("23514");
    expect(await sqlState(teamEntry(teamA, { pinnedVersion: 2 }))).toBe("23514");
    expect(await sqlState(teamEntry(teamA, { versionRule: "pinned", pinnedVersion: 0 }))).toBe(
      "23514",
    );
    expect(await sqlState(teamEntry(teamA, { versionRule: "any" as "latest" }))).toBe("23514");
  });

  it("sets decided_by and decided_at together", async () => {
    await expect(
      teamEntry(teamA, { decidedBy: alice, decidedAt: new Date() }),
    ).resolves.toHaveLength(1);
    expect(await sqlState(teamEntry(teamA, { decidedBy: alice }))).toBe("23514");
    expect(await sqlState(teamEntry(teamA, { decidedAt: new Date() }))).toBe("23514");
  });

  it("refuses an unknown assigner (users are never deleted, so NO ACTION)", async () => {
    expect(await sqlState(teamEntry(teamA, { assignedBy: randomUUID() }))).toBe("23503");
  });
});

describe("site_agent_roster", () => {
  it("is site-wide with one entry per agent and the same checks", async () => {
    const siteAgentId = randomUUID();
    const [made] = await siteEntry({ siteAgentId });
    expect(made).toMatchObject({ state: "active", versionRule: "latest", pinnedVersion: null });
    expect(await sqlState(siteEntry({ siteAgentId }))).toBe("23505");
    expect(await sqlState(siteEntry({ state: "gone" as "active" }))).toBe("23514");
    expect(await sqlState(siteEntry({ versionRule: "pinned" }))).toBe("23514");
    expect(await sqlState(siteEntry({ decidedBy: alice }))).toBe("23514");
    expect(await sqlState(siteEntry({ assignedBy: randomUUID() }))).toBe("23503");
    await app.db
      .update(siteAgentRoster)
      .set({ state: "removed", removedAt: new Date() })
      .where(eq(siteAgentRoster.siteAgentId, siteAgentId));
    await app.db.delete(siteAgentRoster).where(eq(siteAgentRoster.siteAgentId, siteAgentId));
  });
});

describe("site_agents.bound_team_id", () => {
  const agent = (values: Partial<typeof siteAgents.$inferInsert> & { slug: string }) =>
    app.db
      .insert(siteAgents)
      .values({
        scope: "personal",
        ownerUserId: alice,
        frontmatter: { name: values.slug },
        ...values,
      })
      .returning({ id: siteAgents.id, boundTeamId: siteAgents.boundTeamId });

  it("is null by default and carried by personal agents only", async () => {
    const [plain] = await agent({ slug: "unbound" });
    expect(plain?.boundTeamId).toBeNull();
    const [bound] = await agent({ slug: "bound", boundTeamId: teamA });
    expect(bound?.boundTeamId).toBe(teamA);
    expect(
      await sqlState(
        agent({ slug: "bound-gallery", scope: "gallery", ownerUserId: null, boundTeamId: teamA }),
      ),
    ).toBe("23514");
  });

  it("has no foreign key to teams (a bound agent outlives its team)", async () => {
    await expect(agent({ slug: "bound-gone", boundTeamId: randomUUID() })).resolves.toHaveLength(1);
  });
});

const schedule = (extra: Partial<typeof schedules.$inferInsert>) =>
  withTeam(app.db, teamA, (tx) =>
    tx
      .insert(schedules)
      .values({
        teamId: teamA,
        userId: alice,
        agentId: randomUUID(),
        prompt: "Summarise yesterday",
        recurrence: { kind: "daily", at: "08:00" },
        tz: "Europe/Berlin",
        ...extra,
      })
      .returning({ pausedBy: schedules.pausedBy }),
  );

describe("schedules.paused_by agent_unavailable", () => {
  it("accepts agent_unavailable on an inactive schedule", async () => {
    const [made] = await schedule({ active: false, pausedBy: "agent_unavailable" });
    expect(made?.pausedBy).toBe("agent_unavailable");
  });

  it("refuses an unknown value and agent_unavailable on an active schedule", async () => {
    expect(await sqlState(schedule({ active: false, pausedBy: "gone" as "team_admin" }))).toBe(
      "23514",
    );
    expect(await sqlState(schedule({ active: true, pausedBy: "agent_unavailable" }))).toBe("23514");
  });
});
