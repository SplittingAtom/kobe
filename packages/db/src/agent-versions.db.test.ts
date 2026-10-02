import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import {
  installAgents,
  installAgentVersions,
  teamAgents,
  teamAgentVersions,
  teams,
  threads,
  users,
} from "./schema/index.js";
import { withTeam } from "./with-team.js";

/**
 * Published agent versions and thread pins (KOBE-46, D19): versions are immutable in the database,
 * `current_version` always names an existing version, threads pin a version through NO ACTION
 * foreign keys (so a pinned version can't vanish), and no pin crosses a team wall.
 */
const teamA = randomUUID();
const teamB = randomUUID();
const alice = randomUUID();
let app: KobeDatabase;
let owner: KobeDatabase;

beforeAll(async () => {
  owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `av-a-${teamA.slice(0, 8)}`, name: "Versions A" },
    { id: teamB, slug: `av-b-${teamB.slice(0, 8)}`, name: "Versions B" },
  ]);
  await owner.db.insert(users).values({ id: alice, name: "Alice", email: `${alice}@av.test` });
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

const version = (n: number, extra: Partial<typeof teamAgentVersions.$inferInsert> = {}) => ({
  version: n,
  frontmatter: { name: `v${n}` },
  prompt: `prompt ${n}`,
  toolManifest: { format: 1 },
  publishedBy: alice,
  draftRevision: n,
  ...extra,
});

/** A team agent in `teamId` with versions 1..`count` published; returns its id. */
async function publishedTeamAgent(teamId: string, count = 1): Promise<string> {
  return withTeam(app.db, teamId, async (tx) => {
    const [agent] = await tx
      .insert(teamAgents)
      .values({
        teamId,
        ownerUserId: alice,
        slug: `a-${randomUUID().slice(0, 8)}`,
        frontmatter: { name: "A" },
      })
      .returning({ id: teamAgents.id });
    const agentId = agent?.id ?? "";
    for (let n = 1; n <= count; n++) {
      await tx.insert(teamAgentVersions).values({ teamId, agentId, ...version(n) });
    }
    if (count > 0) {
      await tx.update(teamAgents).set({ currentVersion: count }).where(eq(teamAgents.id, agentId));
    }
    return agentId;
  });
}

async function publishedPersonalAgent(): Promise<string> {
  const [agent] = await app.db
    .insert(installAgents)
    .values({
      scope: "personal",
      ownerUserId: alice,
      slug: `p-${randomUUID().slice(0, 8)}`,
      frontmatter: { name: "P" },
    })
    .returning({ id: installAgents.id });
  const agentId = agent?.id ?? "";
  await app.db.insert(installAgentVersions).values({ agentId, ...version(1) });
  await app.db
    .update(installAgents)
    .set({ currentVersion: 1 })
    .where(eq(installAgents.id, agentId));
  return agentId;
}

const pinThread = (
  teamId: string,
  pin: {
    agentScope: "team" | "personal" | "gallery" | null;
    agentId: string | null;
    v: number | null;
  },
) =>
  withTeam(app.db, teamId, (tx) =>
    tx
      .insert(threads)
      .values({
        teamId,
        ownerUserId: alice,
        agentScope: pin.agentScope,
        agentId: pin.agentId,
        agentVersion: pin.v,
      })
      .returning({
        id: threads.id,
        teamAgentId: threads.teamAgentId,
        installAgentId: threads.installAgentId,
      }),
  );

describe("agent versions are immutable (D19)", () => {
  it("refuses updates and direct deletes of a team version, even of its own team", async () => {
    const agentId = await publishedTeamAgent(teamA);
    const update = withTeam(app.db, teamA, (tx) =>
      tx
        .update(teamAgentVersions)
        .set({ prompt: "rewritten" })
        .where(eq(teamAgentVersions.agentId, agentId)),
    );
    expect(await sqlState(update)).toBe("55000");
    const del = withTeam(app.db, teamA, (tx) =>
      tx.delete(teamAgentVersions).where(eq(teamAgentVersions.agentId, agentId)),
    );
    expect(await sqlState(del)).toBe("55000");
  });

  it("gives the app role no UPDATE or DELETE on install versions, and the trigger stops the owner", async () => {
    const agentId = await publishedPersonalAgent();
    const where = eq(installAgentVersions.agentId, agentId);
    expect(
      await sqlState(app.db.update(installAgentVersions).set({ prompt: "x" }).where(where)),
    ).toBe("42501");
    expect(await sqlState(app.db.delete(installAgentVersions).where(where))).toBe("42501");
    expect(
      await sqlState(owner.db.update(installAgentVersions).set({ prompt: "x" }).where(where)),
    ).toBe("55000");
    expect(await sqlState(owner.db.delete(installAgentVersions).where(where))).toBe("55000");
  });

  it("refuses a duplicate version number (concurrent publishes can't both win)", async () => {
    const agentId = await publishedTeamAgent(teamA);
    const dup = withTeam(app.db, teamA, (tx) =>
      tx.insert(teamAgentVersions).values({ teamId: teamA, agentId, ...version(1) }),
    );
    expect(await sqlState(dup)).toBe("23505");
  });

  it("refuses deleting an agent that has versions (it is archived instead)", async () => {
    const agentId = await publishedTeamAgent(teamA);
    const del = withTeam(app.db, teamA, (tx) =>
      tx.delete(teamAgents).where(eq(teamAgents.id, agentId)),
    );
    expect(await sqlState(del)).toBe("23503");
    const personal = await publishedPersonalAgent();
    expect(await sqlState(app.db.delete(installAgents).where(eq(installAgents.id, personal)))).toBe(
      "23503",
    );
  });

  it("keeps current_version pointing at an existing version", async () => {
    const agentId = await publishedTeamAgent(teamA);
    const ahead = withTeam(app.db, teamA, (tx) =>
      tx.update(teamAgents).set({ currentVersion: 2 }).where(eq(teamAgents.id, agentId)),
    );
    expect(await sqlState(ahead)).toBe("23503");
    const personal = await publishedPersonalAgent();
    expect(
      await sqlState(
        app.db
          .update(installAgents)
          .set({ currentVersion: 5 })
          .where(eq(installAgents.id, personal)),
      ),
    ).toBe("23503");
  });

  it.each([
    ["both a draft revision and a source version", { draftRevision: 1, republishedFrom: 1 }],
    ["neither origin", { draftRevision: null, republishedFrom: null }],
    ["a rollback from a later version", { draftRevision: null, republishedFrom: 3 }],
    ["version 0", { version: 0 }],
    ["a non-object manifest", { toolManifest: [] as unknown as Record<string, unknown> }],
  ])("rejects %s", async (_name, extra) => {
    const agentId = await publishedTeamAgent(teamA, 0);
    const insert = withTeam(app.db, teamA, (tx) =>
      tx.insert(teamAgentVersions).values({ teamId: teamA, agentId, ...version(2, extra) }),
    );
    expect(await sqlState(insert)).toBe("23514");
  });

  it("is invisible to another team and can't be written for one", async () => {
    const agentId = await publishedTeamAgent(teamA);
    const fromB = await withTeam(app.db, teamB, (tx) =>
      tx.select().from(teamAgentVersions).where(eq(teamAgentVersions.agentId, agentId)),
    );
    expect(fromB).toEqual([]);
    const smuggle = withTeam(app.db, teamB, (tx) =>
      tx.insert(teamAgentVersions).values({ teamId: teamA, agentId, ...version(9) }),
    );
    expect(await sqlState(smuggle)).toBe("42501");
  });
});

describe("threads pin a published version", () => {
  it("pins a team version through the generated team_agent_id", async () => {
    const agentId = await publishedTeamAgent(teamA);
    const [row] = await pinThread(teamA, { agentScope: "team", agentId, v: 1 });
    expect(row).toMatchObject({ teamAgentId: agentId, installAgentId: null });
  });

  it("pins a personal version through the generated install_agent_id", async () => {
    const agentId = await publishedPersonalAgent();
    const [row] = await pinThread(teamA, { agentScope: "personal", agentId, v: 1 });
    expect(row).toMatchObject({ teamAgentId: null, installAgentId: agentId });
  });

  it("refuses a version that was never published", async () => {
    const agentId = await publishedTeamAgent(teamA);
    expect(await sqlState(pinThread(teamA, { agentScope: "team", agentId, v: 2 }))).toBe("23503");
  });

  it("refuses another team's agent version (the foreign key includes team_id)", async () => {
    const agentId = await publishedTeamAgent(teamA);
    expect(await sqlState(pinThread(teamB, { agentScope: "team", agentId, v: 1 }))).toBe("23503");
  });

  it("refuses a pin under the wrong scope", async () => {
    const teamAgent = await publishedTeamAgent(teamA);
    const personal = await publishedPersonalAgent();
    expect(
      await sqlState(pinThread(teamA, { agentScope: "gallery", agentId: teamAgent, v: 1 })),
    ).toBe("23503");
    expect(await sqlState(pinThread(teamA, { agentScope: "team", agentId: personal, v: 1 }))).toBe(
      "23503",
    );
  });

  it("requires scope, agent and version together", async () => {
    const agentId = await publishedTeamAgent(teamA);
    expect(await sqlState(pinThread(teamA, { agentScope: null, agentId, v: 1 }))).toBe("23514");
    expect(await sqlState(pinThread(teamA, { agentScope: "team", agentId: null, v: null }))).toBe(
      "23514",
    );
    await expect(
      pinThread(teamA, { agentScope: null, agentId: null, v: null }),
    ).resolves.toHaveLength(1);
  });

  it("survives publishing v2: the v1 pin stays and v1 stays readable", async () => {
    const agentId = await publishedTeamAgent(teamA);
    const [thread] = await pinThread(teamA, { agentScope: "team", agentId, v: 1 });
    await withTeam(app.db, teamA, async (tx) => {
      await tx.insert(teamAgentVersions).values({ teamId: teamA, agentId, ...version(2) });
      await tx.update(teamAgents).set({ currentVersion: 2 }).where(eq(teamAgents.id, agentId));
    });
    const [pinned] = await withTeam(app.db, teamA, (tx) =>
      tx
        .select({ v: threads.agentVersion })
        .from(threads)
        .where(eq(threads.id, thread?.id ?? "")),
    );
    expect(pinned?.v).toBe(1);
  });

  it("lets a team's deletion cascade through agents, versions and pinned threads", async () => {
    const doomed = randomUUID();
    await owner.db
      .insert(teams)
      .values({ id: doomed, slug: `av-d-${doomed.slice(0, 8)}`, name: "D" });
    const agentId = await publishedTeamAgent(doomed, 2);
    await pinThread(doomed, { agentScope: "team", agentId, v: 1 });
    await owner.db.delete(teams).where(eq(teams.id, doomed));
    // As the app role inside the deleted team's context (FORCE RLS applies to the owner too).
    const left = await withTeam(app.db, doomed, async (tx) => ({
      versions: (await tx.select().from(teamAgentVersions)).length,
      agents: (await tx.select().from(teamAgents)).length,
      threads: (await tx.select().from(threads)).length,
    }));
    expect(left).toEqual({ versions: 0, agents: 0, threads: 0 });
  });
});
