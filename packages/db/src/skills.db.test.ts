import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import {
  installSkills,
  installSkillVersions,
  teams,
  teamSkills,
  teamSkillVersions,
  users,
} from "./schema/index.js";
import { withTeam } from "./with-team.js";

/**
 * Skill bundles (KOBE-78): versions are immutable in the database, a skill with versions can't be
 * deleted, and a team's skills are invisible to and unwritable by another team.
 */
const teamA = randomUUID();
const teamB = randomUUID();
const alice = randomUUID();
let app: KobeDatabase;
let owner: KobeDatabase;

beforeAll(async () => {
  owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `sk-a-${teamA.slice(0, 8)}`, name: "Skills A" },
    { id: teamB, slug: `sk-b-${teamB.slice(0, 8)}`, name: "Skills B" },
  ]);
  await owner.db.insert(users).values({ id: alice, name: "Alice", email: `${alice}@sk.test` });
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

const version = (n: number) => ({
  version: n,
  frontmatter: { name: "demo", description: "d" },
  source: "zip" as const,
  contentHash: String(n).repeat(64).slice(0, 64),
  storageKey: `k/${n}`,
  sizeBytes: 10,
  fileCount: 1,
  uncompressedBytes: 20,
  uploadedBy: alice,
});

async function teamSkillWithVersion(teamId: string): Promise<string> {
  return withTeam(app.db, teamId, async (tx) => {
    const [skill] = await tx
      .insert(teamSkills)
      .values({
        teamId,
        ownerUserId: alice,
        slug: `s-${randomUUID().slice(0, 8)}`,
        description: "d",
      })
      .returning({ id: teamSkills.id });
    if (!skill) throw new Error("no skill");
    await tx.insert(teamSkillVersions).values({ teamId, skillId: skill.id, ...version(1) });
    return skill.id;
  });
}

async function personalSkillWithVersion(): Promise<string> {
  const [skill] = await app.db
    .insert(installSkills)
    .values({ ownerUserId: alice, slug: `p-${randomUUID().slice(0, 8)}`, description: "d" })
    .returning({ id: installSkills.id });
  if (!skill) throw new Error("no skill");
  await app.db.insert(installSkillVersions).values({ skillId: skill.id, ...version(1) });
  return skill.id;
}

describe("skill versions are immutable", () => {
  it("refuses updates and direct deletes of a team version", async () => {
    const skillId = await teamSkillWithVersion(teamA);
    const where = eq(teamSkillVersions.skillId, skillId);
    expect(
      await sqlState(
        withTeam(app.db, teamA, (tx) =>
          tx
            .update(teamSkillVersions)
            .set({ contentHash: "a".repeat(64) })
            .where(where),
        ),
      ),
    ).toBe("55000");
    expect(
      await sqlState(withTeam(app.db, teamA, (tx) => tx.delete(teamSkillVersions).where(where))),
    ).toBe("55000");
  });

  it("gives the app role no UPDATE or DELETE on personal versions; the trigger stops the owner", async () => {
    const skillId = await personalSkillWithVersion();
    const where = eq(installSkillVersions.skillId, skillId);
    expect(
      await sqlState(app.db.update(installSkillVersions).set({ storageKey: "x" }).where(where)),
    ).toBe("42501");
    expect(await sqlState(app.db.delete(installSkillVersions).where(where))).toBe("42501");
    expect(
      await sqlState(owner.db.update(installSkillVersions).set({ storageKey: "x" }).where(where)),
    ).toBe("55000");
    expect(await sqlState(owner.db.delete(installSkillVersions).where(where))).toBe("55000");
  });

  it("refuses a duplicate version number and a malformed hash", async () => {
    const skillId = await teamSkillWithVersion(teamA);
    const dup = withTeam(app.db, teamA, (tx) =>
      tx.insert(teamSkillVersions).values({ teamId: teamA, skillId, ...version(1) }),
    );
    expect(await sqlState(dup)).toBe("23505");
    const bad = withTeam(app.db, teamA, (tx) =>
      tx
        .insert(teamSkillVersions)
        .values({ teamId: teamA, skillId, ...version(2), contentHash: "XYZ" }),
    );
    expect(await sqlState(bad)).toBe("23514");
  });

  it("refuses deleting a skill that has versions", async () => {
    const skillId = await teamSkillWithVersion(teamA);
    const del = withTeam(app.db, teamA, (tx) =>
      tx.delete(teamSkills).where(eq(teamSkills.id, skillId)),
    );
    expect(await sqlState(del)).toBe("23503");
  });

  it("lets a team's deletion cascade through skills and versions", async () => {
    const doomed = randomUUID();
    await owner.db
      .insert(teams)
      .values({ id: doomed, slug: `sk-d-${doomed.slice(0, 8)}`, name: "D" });
    await teamSkillWithVersion(doomed);
    await owner.db.delete(teams).where(eq(teams.id, doomed));
    const rows = await owner.db
      .select()
      .from(teamSkillVersions)
      .where(eq(teamSkillVersions.teamId, doomed));
    expect(rows).toEqual([]);
  });
});

describe("team isolation", () => {
  it("hides a team's skills from another team and refuses writes for it", async () => {
    const skillId = await teamSkillWithVersion(teamA);
    const seen = await withTeam(app.db, teamB, (tx) =>
      tx.select().from(teamSkills).where(eq(teamSkills.id, skillId)),
    );
    expect(seen).toEqual([]);
    const forged = withTeam(app.db, teamB, (tx) =>
      tx
        .insert(teamSkills)
        .values({ teamId: teamA, ownerUserId: alice, slug: "forged", description: "d" }),
    );
    expect(await sqlState(forged)).toBe("42501");
  });
});

describe("catalog: skill version triggers", () => {
  it("has exactly the immutability triggers, and no other function touches version tables", async () => {
    const triggers = await owner.pool.query<{ rel: string; name: string }>(
      `SELECT tgrelid::regclass::text AS rel, tgname AS name FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgrelid IN ('team_skill_versions'::regclass, 'install_skill_versions'::regclass)
       ORDER BY 1, 2`,
    );
    expect(triggers.rows).toEqual([
      { rel: "install_skill_versions", name: "install_skill_versions_immutable" },
      { rel: "team_skill_versions", name: "team_skill_versions_immutable" },
    ]);
    const functions = await owner.pool.query<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosrc ILIKE '%skill_versions%' ORDER BY 1`,
    );
    expect(functions.rows).toEqual([{ name: "skill_versions_immutable" }]);
  });
});
