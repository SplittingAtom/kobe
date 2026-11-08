import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import {
  siteAgentRoster,
  siteAgents,
  siteAgentVersions,
  teamAgentRoster,
  teams,
  threads,
  users,
} from "./schema/index.js";
import { withTeam } from "./with-team.js";

/**
 * Thread pins of rostered personal agents (KOBE-567, agents-roster AR9, §6.2; migration 0195):
 * `threads_agent_pin_owner` accepts a personal pin by its owner, or by anyone in a team that runs
 * the agent through an `active` team or site roster entry (not bound elsewhere). An existing pin
 * survives the entry's removal (D19). Runs as the app role.
 */
const teamA = randomUUID();
const teamB = randomUUID();
const alice = randomUUID(); // the agents' owner
const bob = randomUUID(); // another member
let app: KobeDatabase;

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `tp-a-${teamA.slice(0, 8)}`, name: "Pins A" },
    { id: teamB, slug: `tp-b-${teamB.slice(0, 8)}`, name: "Pins B" },
  ]);
  await owner.db.insert(users).values([
    { id: alice, name: "Alice", email: `${alice}@pins.test` },
    { id: bob, name: "Bob", email: `${bob}@pins.test` },
  ]);
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

const version = (n: number) => ({
  version: n,
  frontmatter: { name: `v${n}` },
  prompt: `prompt ${n}`,
  toolManifest: { format: 1 },
  skillManifest: { skills: [] },
  publishedBy: alice,
  draftRevision: n,
});

/** Alice's personal agent with versions 1 and 2 published. */
async function alicesAgent(boundTeamId: string | null = null): Promise<string> {
  const [agent] = await app.db
    .insert(siteAgents)
    .values({
      scope: "personal",
      ownerUserId: alice,
      boundTeamId,
      slug: `p-${randomUUID().slice(0, 8)}`,
      frontmatter: { name: "P" },
    })
    .returning({ id: siteAgents.id });
  const agentId = agent?.id ?? "";
  await app.db.insert(siteAgentVersions).values([
    { agentId, ...version(1) },
    { agentId, ...version(2) },
  ]);
  await app.db.update(siteAgents).set({ currentVersion: 2 }).where(eq(siteAgents.id, agentId));
  return agentId;
}

const teamEntry = (teamId: string, agentId: string, state: "active" | "proposed" | "removed") =>
  withTeam(app.db, teamId, (tx) =>
    tx.insert(teamAgentRoster).values({ teamId, siteAgentId: agentId, assignedBy: alice, state }),
  );

const pin = (teamId: string, agentId: string, owner = bob, v = 1) =>
  withTeam(app.db, teamId, (tx) =>
    tx
      .insert(threads)
      .values({ teamId, ownerUserId: owner, agentScope: "personal", agentId, agentVersion: v })
      .returning({ id: threads.id }),
  );

const updateThread = (teamId: string, id: string, set: Partial<typeof threads.$inferInsert>) =>
  withTeam(app.db, teamId, (tx) =>
    tx
      .update(threads)
      .set(set)
      .where(and(eq(threads.teamId, teamId), eq(threads.id, id))),
  );

describe("threads_agent_pin_owner with rosters (KOBE-567)", () => {
  it("lets another member pin an agent with an active entry on their team's roster", async () => {
    const agent = await alicesAgent();
    await teamEntry(teamA, agent, "active");
    await expect(pin(teamA, agent)).resolves.toHaveLength(1);
    // Not in another team without an entry there.
    expect(await sqlState(pin(teamB, agent))).toBe("23514");
  });

  it("lets any team pin an agent with an active site entry", async () => {
    const agent = await alicesAgent();
    await app.db.insert(siteAgentRoster).values({ siteAgentId: agent, assignedBy: alice });
    await expect(pin(teamA, agent)).resolves.toHaveLength(1);
    await expect(pin(teamB, agent)).resolves.toHaveLength(1);
  });

  it("refuses an unassigned other-owner agent, and proposed or removed entries (as today)", async () => {
    const agent = await alicesAgent();
    expect(await sqlState(pin(teamA, agent))).toBe("23514");
    await teamEntry(teamA, agent, "proposed");
    expect(await sqlState(pin(teamA, agent))).toBe("23514");
    const other = await alicesAgent();
    await teamEntry(teamA, other, "removed");
    await app.db
      .insert(siteAgentRoster)
      .values({ siteAgentId: other, assignedBy: alice, state: "proposed" });
    expect(await sqlState(pin(teamA, other))).toBe("23514");
    // The owner still pins their own agent with no entry at all.
    await expect(pin(teamA, agent, alice)).resolves.toHaveLength(1);
  });

  it("refuses a bound agent in another team, even with an entry there", async () => {
    const agent = await alicesAgent(teamA);
    await teamEntry(teamB, agent, "active");
    expect(await sqlState(pin(teamB, agent))).toBe("23514");
    await teamEntry(teamA, agent, "active");
    await expect(pin(teamA, agent)).resolves.toHaveLength(1);
  });

  it("keeps an existing pin after removal: rename and archive pass, a version switch is re-checked", async () => {
    const agent = await alicesAgent();
    await teamEntry(teamA, agent, "active");
    const [row] = await pin(teamA, agent);
    const id = row?.id ?? "";
    await withTeam(app.db, teamA, (tx) =>
      tx
        .update(teamAgentRoster)
        .set({ state: "removed", removedAt: new Date() })
        .where(and(eq(teamAgentRoster.teamId, teamA), eq(teamAgentRoster.siteAgentId, agent))),
    );
    await expect(updateThread(teamA, id, { title: "Renamed" })).resolves.toBeDefined();
    await expect(updateThread(teamA, id, { archivedAt: new Date() })).resolves.toBeDefined();
    // Setting the pin columns to the same values is not a change.
    await expect(
      updateThread(teamA, id, { agentScope: "personal", agentId: agent, agentVersion: 1 }),
    ).resolves.toBeDefined();
    expect(await sqlState(updateThread(teamA, id, { agentVersion: 2 }))).toBe("23514");
  });
});
