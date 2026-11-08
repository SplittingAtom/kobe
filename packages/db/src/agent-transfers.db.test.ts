import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { agentTransfers, siteAgents, teams, users } from "./schema/index.js";
import { withTeam } from "./with-team.js";

/**
 * Agent transfers (KOBE-568, spec agents-roster AR10): a team table behind RLS, one pending offer
 * per agent site-wide, state and decision shape, parties distinct, offers gone with their agent or
 * team. Runs as the app role.
 */
const teamA = randomUUID();
const teamB = randomUUID();
const alice = randomUUID();
const bob = randomUUID();
let app: KobeDatabase;

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `tr-a-${teamA.slice(0, 8)}`, name: "Transfer A" },
    { id: teamB, slug: `tr-b-${teamB.slice(0, 8)}`, name: "Transfer B" },
  ]);
  await owner.db.insert(users).values([
    { id: alice, name: "Alice", email: `${alice}@transfer.test` },
    { id: bob, name: "Bob", email: `${bob}@transfer.test` },
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

async function agent(): Promise<string> {
  const id = randomUUID();
  await app.db.insert(siteAgents).values({
    id,
    scope: "personal",
    ownerUserId: alice,
    slug: `t-${id.slice(0, 8)}`,
    frontmatter: { name: "T" },
    prompt: "T.",
  });
  return id;
}

const offer = (
  teamId: string,
  siteAgentId: string,
  extra: Partial<typeof agentTransfers.$inferInsert> = {},
  asTeam = teamId,
) =>
  withTeam(app.db, asTeam, (tx) =>
    tx
      .insert(agentTransfers)
      .values({ teamId, siteAgentId, fromUserId: alice, toUserId: bob, ...extra })
      .returning(),
  );

describe("agent_transfers (KOBE-568)", () => {
  it("is invisible and unwritable from another team", async () => {
    const id = await agent();
    const [row] = await offer(teamA, id);
    expect(row).toMatchObject({ state: "pending", decidedAt: null });
    const seen = await withTeam(app.db, teamB, (tx) =>
      tx.select().from(agentTransfers).where(eq(agentTransfers.siteAgentId, id)),
    );
    expect(seen).toEqual([]);
    expect(await sqlState(offer(teamA, await agent(), {}, teamB))).toBe("42501");
    const outside = await app.db.select().from(agentTransfers);
    expect(outside).toEqual([]);
  });

  it("holds one pending offer per agent, across teams; decided rows are history", async () => {
    const id = await agent();
    await offer(teamA, id);
    expect(await sqlState(offer(teamB, id))).toBe("23505");
    await withTeam(app.db, teamA, (tx) =>
      tx
        .update(agentTransfers)
        .set({ state: "declined", decidedAt: new Date() })
        .where(and(eq(agentTransfers.teamId, teamA), eq(agentTransfers.siteAgentId, id))),
    );
    expect(await sqlState(offer(teamB, id))).toBeUndefined();
  });

  it("checks the state, the decision shape and distinct parties", async () => {
    expect(await sqlState(offer(teamA, await agent(), { state: "lost" as never }))).toBe("23514");
    expect(await sqlState(offer(teamA, await agent(), { state: "accepted" }))).toBe("23514");
    expect(await sqlState(offer(teamA, await agent(), { decidedAt: new Date() }))).toBe("23514");
    expect(await sqlState(offer(teamA, await agent(), { toUserId: alice }))).toBe("23514");
    expect(await sqlState(offer(teamA, randomUUID()))).toBe("23503");
  });

  it("drops offers with their agent", async () => {
    const id = await agent();
    await offer(teamA, id);
    await app.db.delete(siteAgents).where(eq(siteAgents.id, id));
    const left = await withTeam(app.db, teamA, (tx) =>
      tx.select().from(agentTransfers).where(eq(agentTransfers.siteAgentId, id)),
    );
    expect(left).toEqual([]);
  });
});
