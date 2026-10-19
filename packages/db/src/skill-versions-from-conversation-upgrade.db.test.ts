import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import {
  createTestDatabase,
  migrationsBefore,
  testServerUrl,
  type TestDatabase,
} from "./test-support/database.js";

/**
 * KOBE-333 review C4-M3: versions saved before 0153 get `from_conversation` from the audit log
 * (0157, run as the non-superuser owner with FORCE and the immutability triggers lifted for it):
 * a team version saved from a conversation draft, a personal version saved (personalized) from
 * one, and nothing else; FORCE and the triggers are back afterwards.
 */
const MARKER = 'ADD COLUMN "from_conversation"';

let db: TestDatabase | undefined;
let oldMigrations = "";
const suffix = randomBytes(4).toString("hex");
const ids = {
  user: randomUUID(),
  team: randomUUID(),
  otherTeam: randomUUID(),
  teamSkill: randomUUID(),
  personal: randomUUID(),
  draft: randomUUID(),
  blankDraft: randomUUID(),
};

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const version = (table: string, extra: string, values: unknown[]) =>
  `INSERT INTO ${table} (${extra}skill_id, version, seq, semver, frontmatter, source, content_hash,
     storage_key, size_bytes, file_count, uncompressed_bytes, uploaded_by)
   VALUES (${values.map((_, i) => `$${i + 1}`).join(", ")}, '{"name":"x"}', 'zip', repeat('a', 64),
     'k', 1, 1, 1, $${values.length + 1})`;

const audit = (c: pg.Client, action: string, teamId: string | null, target: object) =>
  c.query(
    `INSERT INTO audit_log (actor_kind, action, team_id, target) VALUES ('system', $1, $2, $3)`,
    [action, teamId, JSON.stringify(target)],
  );

beforeAll(async () => {
  oldMigrations = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: oldMigrations });
  await withClient(db.adminUrl, async (c) => {
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      ids.user,
      `u-${suffix}@example.test`,
    ]);
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T'), ($3, $4, 'O')`, [
      ids.team,
      `t-${suffix}`,
      ids.otherTeam,
      `o-${suffix}`,
    ]);
    await c.query("BEGIN");
    await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [ids.team]);
    await c.query(
      `INSERT INTO team_skills (team_id, id, owner_user_id, slug, description, latest_version)
       VALUES ($1, $2, $3, 'from-chat', 'd', 2)`,
      [ids.team, ids.teamSkill, ids.user],
    );
    for (const n of [1, 2])
      await c.query(version("team_skill_versions", "team_id, ", [1, 2, 3, 4, 5]), [
        ids.team,
        ids.teamSkill,
        n,
        n,
        `0.${n}.0`,
        ids.user,
      ]);
    await c.query("COMMIT");
    await c.query(
      `INSERT INTO personal_skills (id, owner_user_id, slug, description, latest_version)
       VALUES ($1, $2, 'mine', 'd', 1)`,
      [ids.personal, ids.user],
    );
    await c.query(version("personal_skill_versions", "", [1, 2, 3, 4]), [
      ids.personal,
      1,
      1,
      "0.1.0",
      ids.user,
    ]);
    // Version 1 of the team skill came from a conversation draft; version 2 from a blank one.
    await audit(c, "skill.draft.created", ids.team, { draftId: ids.draft, startedFrom: "thread" });
    await audit(c, "skill.draft.created", ids.team, {
      draftId: ids.blankDraft,
      startedFrom: "blank",
    });
    await audit(c, "skill.uploaded", ids.team, {
      skillId: ids.teamSkill,
      scope: "team",
      version: 1,
      draftId: ids.draft,
    });
    await audit(c, "skill.uploaded", ids.team, {
      skillId: ids.teamSkill,
      scope: "team",
      version: 2,
      draftId: ids.blankDraft,
    });
    // Review LOW-R1: another team's draft row with the blank draft's id (a look-alike) counts
    // for nothing: a team version's draft is its own team's.
    await audit(c, "skill.draft.created", ids.otherTeam, {
      draftId: ids.blankDraft,
      startedFrom: "thread",
    });
    await audit(c, "skill.draft.personalized", ids.team, {
      skillId: ids.personal,
      semver: "0.1.0",
      fromConversation: true,
    });
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("from_conversation backfill (KOBE-333 review)", () => {
  it("marks exactly the versions saved from a conversation", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      const team = await c.query(
        `SELECT version, from_conversation FROM team_skill_versions ORDER BY version`,
      );
      expect(team.rows).toEqual([
        { version: 1, from_conversation: true },
        { version: 2, from_conversation: false },
      ]);
      const personal = await c.query(`SELECT from_conversation FROM personal_skill_versions`);
      expect(personal.rows).toEqual([{ from_conversation: true }]);
      const rls = await c.query(
        `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'team_skill_versions'`,
      );
      expect(rls.rows).toEqual([{ relforcerowsecurity: true }]);
      const triggers = await c.query(
        `SELECT tgname, tgenabled FROM pg_trigger WHERE tgname LIKE '%skill_versions_immutable' ORDER BY tgname`,
      );
      expect(triggers.rows.every((t: { tgenabled: string }) => t.tgenabled === "O")).toBe(true);
    });
  });
});
