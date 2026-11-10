import { randomUUID } from "node:crypto";
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
 * KOBE-587 (projects-in-conversations RV2) as an upgrade runs it (the owner role) over a populated
 * database: a restricted project with explicit readers and editors becomes readable by every
 * workspace member (projects.visibility and its check are gone), its reader rows are deleted, its
 * owners and editors stay, project_members.role is checked IN ('owner','editor'), and FORCE RLS
 * stays on both tables.
 */
const MARKER = `ALTER TABLE "projects" DROP COLUMN "visibility"`;

let db: TestDatabase | undefined;
let older = "";
const teamId = randomUUID();
const otherTeam = randomUUID();
const owner = randomUUID();
const editor = randomUUID();
const reader = randomUUID();
const outsider = randomUUID();
const restricted = randomUUID();
const open = randomUUID();
const otherRestricted = randomUUID();

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};

const asAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(database().adminUrl, fn);

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await asAdmin(async (c) => {
    for (const id of [teamId, otherTeam]) {
      await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [
        id,
        `t${id.slice(0, 8)}`,
      ]);
    }
    for (const id of [owner, editor, reader, outsider]) {
      await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
        id,
        `${id}@upgrade.test`,
      ]);
    }
    await c.query(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, 'contributor'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'),
              ($6, $2, 'contributor'), ($6, $4, 'member')`,
      [teamId, owner, editor, reader, outsider, otherTeam],
    );
    await c.query(
      `INSERT INTO projects (team_id, id, slug, name, visibility, created_by)
       VALUES ($1, $2, 'closed', 'Closed', 'restricted', $4), ($1, $3, 'open', 'Open', 'workspace', $4),
              ($5, $6, 'other', 'Other', 'restricted', $4)`,
      [teamId, restricted, open, owner, otherTeam, otherRestricted],
    );
    await c.query(
      `INSERT INTO project_members (team_id, project_id, user_id, role, added_by)
       VALUES ($1, $2, $4, 'owner', $4), ($1, $2, $5, 'editor', $4), ($1, $2, $6, 'reader', $4),
              ($1, $3, $4, 'owner', $4), ($1, $3, $6, 'reader', $4),
              ($7, $8, $4, 'owner', $4), ($7, $8, $6, 'reader', $4)`,
      [teamId, restricted, open, owner, editor, reader, otherTeam, otherRestricted],
    );
  });
  await runMigrations({ databaseUrl: database().ownerUrl, appRole: database().appRole });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("Restricted visibility removed on upgrade (KOBE-587, RV2)", () => {
  it("drops projects.visibility and its check", async () => {
    const { rows: cols } = await asAdmin((c) =>
      c.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'projects' AND column_name = 'visibility'`,
      ),
    );
    expect(cols).toEqual([]);
    const { rows: checks } = await asAdmin((c) =>
      c.query(`SELECT conname FROM pg_constraint WHERE conname = 'projects_visibility'`),
    );
    expect(checks).toEqual([]);
    const { rows: projects } = await asAdmin((c) =>
      c.query(`SELECT id FROM projects ORDER BY slug`),
    );
    expect(projects.map((r) => r.id)).toEqual([restricted, open, otherRestricted]);
  });

  it("deletes reader rows and keeps owners and editors", async () => {
    const { rows } = await asAdmin((c) =>
      c.query(
        `SELECT team_id, project_id, user_id, role FROM project_members ORDER BY team_id, project_id, role`,
      ),
    );
    const got = rows
      .map(
        (r) =>
          `${r.project_id === restricted ? "closed" : r.project_id === open ? "open" : "other"}:${r.user_id === owner ? "owner" : r.user_id === editor ? "editor" : "reader"}:${r.role}`,
      )
      .sort();
    expect(got).toEqual([
      "closed:editor:editor",
      "closed:owner:owner",
      "open:owner:owner",
      "other:owner:owner",
    ]);
  });

  it("checks role IN ('owner','editor')", async () => {
    const def = await asAdmin((c) =>
      c.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'project_members_role'`,
      ),
    );
    expect(def.rows[0]?.def).toContain("'owner'");
    expect(def.rows[0]?.def).toContain("'editor'");
    expect(def.rows[0]?.def).not.toContain("'reader'");
    await expect(
      asAdmin((c) =>
        c.query(
          `INSERT INTO project_members (team_id, project_id, user_id, role, added_by)
           VALUES ($1, $2, $3, 'reader', $4)`,
          [teamId, restricted, outsider, owner],
        ),
      ),
    ).rejects.toThrow(/project_members_role/);
  });

  it("keeps FORCE RLS, so the app role sees every project of its own team and none of another", async () => {
    const { rows: force } = await asAdmin((c) =>
      c.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname IN ('projects', 'project_members') ORDER BY relname`,
      ),
    );
    expect(force).toEqual([
      { relname: "project_members", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "projects", relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const seen = await withClient(database().appUrl, async (c) => {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [teamId]);
      const { rows } = await c.query(`SELECT id FROM projects ORDER BY slug`);
      await c.query("ROLLBACK");
      return rows.map((r) => r.id);
    });
    expect(seen).toEqual([restricted, open]);
  });
});
