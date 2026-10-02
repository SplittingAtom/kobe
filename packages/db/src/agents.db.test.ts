import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { installAgents, teamAgents, teams, users } from "./schema/index.js";
import { withTeam } from "./with-team.js";

/**
 * Agent definition tables (KOBE-45): team agents behind team RLS, personal and gallery agents
 * install-wide, with slug uniqueness per scope and backstop checks. Runs as the app role.
 */
const teamA = randomUUID();
const teamB = randomUUID();
const alice = randomUUID();
const bob = randomUUID();
let app: KobeDatabase;

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `ag-a-${teamA.slice(0, 8)}`, name: "Agents A" },
    { id: teamB, slug: `ag-b-${teamB.slice(0, 8)}`, name: "Agents B" },
  ]);
  await owner.db.insert(users).values([
    { id: alice, name: "Alice", email: `${alice}@agents.test` },
    { id: bob, name: "Bob", email: `${bob}@agents.test` },
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

const teamAgent = (
  teamId: string,
  slug: string,
  extra: Partial<typeof teamAgents.$inferInsert> = {},
) =>
  withTeam(app.db, teamId, (tx) =>
    tx
      .insert(teamAgents)
      .values({ teamId, ownerUserId: alice, slug, frontmatter: { name: slug }, ...extra })
      .returning({ id: teamAgents.id }),
  );

const installAgent = (values: Partial<typeof installAgents.$inferInsert> & { slug: string }) =>
  app.db
    .insert(installAgents)
    .values({
      scope: "personal",
      ownerUserId: alice,
      frontmatter: { name: values.slug },
      ...values,
    })
    .returning({ id: installAgents.id });

describe("team_agents", () => {
  it("keeps slugs unique per team, not across teams", async () => {
    await teamAgent(teamA, "writer");
    expect(await sqlState(teamAgent(teamA, "writer"))).toBe("23505");
    await expect(teamAgent(teamB, "writer")).resolves.toHaveLength(1);
  });

  it("is invisible from another team and outside withTeam", async () => {
    const [row] = await teamAgent(teamA, "hidden");
    const fromB = await withTeam(app.db, teamB, (tx) =>
      tx.select().from(teamAgents).where(eq(teamAgents.id, row!.id)),
    );
    expect(fromB).toEqual([]);
    expect(await app.db.select().from(teamAgents)).toEqual([]);
  });

  it("refuses rows for another team (RLS WITH CHECK)", async () => {
    const insert = withTeam(app.db, teamA, (tx) =>
      tx
        .insert(teamAgents)
        .values({
          teamId: teamB,
          ownerUserId: alice,
          slug: "smuggled",
          frontmatter: { name: "x" },
        }),
    );
    expect(await sqlState(insert)).toBe("42501");
  });

  it.each([
    ["a bad slug", { slug: "Bad Slug" }],
    ["a trailing hyphen", { slug: "bad-" }],
    [
      "a non-object frontmatter",
      { slug: "arr", frontmatter: ["x"] as unknown as Record<string, unknown> },
    ],
    ["an oversized prompt", { slug: "big", prompt: "p".repeat(100 * 1024 + 1) }],
    ["revision 0", { slug: "rev", revision: 0 }],
    ["current_version 0", { slug: "ver", currentVersion: 0 }],
  ])("rejects %s", async (_name, values) => {
    expect(await sqlState(teamAgent(teamA, values.slug, values))).toBe("23514");
  });

  it("refuses an unknown owner (users are never deleted, so NO ACTION)", async () => {
    expect(await sqlState(teamAgent(teamA, "orphan", { ownerUserId: randomUUID() }))).toBe("23503");
  });
});

describe("install_agents (personal and gallery)", () => {
  it("requires an owner for personal agents and forbids one for gallery agents", async () => {
    expect(await sqlState(installAgent({ slug: "no-owner", ownerUserId: null }))).toBe("23514");
    expect(await sqlState(installAgent({ slug: "owned-gallery", scope: "gallery" }))).toBe("23514");
    await expect(
      installAgent({ slug: "gallery-ok", scope: "gallery", ownerUserId: null }),
    ).resolves.toHaveLength(1);
  });

  it("keeps personal slugs unique per owner and gallery slugs unique install-wide", async () => {
    await installAgent({ slug: "mine" });
    expect(await sqlState(installAgent({ slug: "mine" }))).toBe("23505");
    await expect(installAgent({ slug: "mine", ownerUserId: bob })).resolves.toHaveLength(1);
    await expect(
      installAgent({ slug: "mine", scope: "gallery", ownerUserId: null }),
    ).resolves.toHaveLength(1);
    expect(
      await sqlState(installAgent({ slug: "mine", scope: "gallery", ownerUserId: null })),
    ).toBe("23505");
  });

  it("lets the app role update and delete (no team data hangs off these rows)", async () => {
    const [row] = await installAgent({ slug: "temp" });
    await app.db
      .update(installAgents)
      .set({ prompt: "changed", revision: 2 })
      .where(eq(installAgents.id, row!.id));
    const deleted = await app.db
      .delete(installAgents)
      .where(eq(installAgents.id, row!.id))
      .returning({ id: installAgents.id });
    expect(deleted).toHaveLength(1);
  });

  it("applies the same backstop checks as team agents", async () => {
    expect(await sqlState(installAgent({ slug: "x".repeat(49) }))).toBe("23514");
    expect(await sqlState(installAgent({ slug: "huge", prompt: "p".repeat(100 * 1024 + 1) }))).toBe(
      "23514",
    );
  });
});
