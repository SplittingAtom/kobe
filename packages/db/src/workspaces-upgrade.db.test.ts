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
 * KOBE-577's migrations (0198 role rename, 0199 tables and columns, 0200 RLS, keys and hold guard,
 * 0201 backfills) as an upgrade runs them (the owner role) over a populated database: MG1
 * `builder` members and invitations are `contributor`; MG2 `members_mode` team/selected became
 * visibility workspace/restricted and the column is gone; MG3 `member` rows are `editor`; MG4 one
 * "Imported" commit per project with files, its tree equal to project_files, head and live counters
 * set, projects without files keep a null head; the new tables are under FORCE RLS for the app.
 */
const MARKER = `ALTER TYPE "public"."team_role" RENAME VALUE 'builder' TO 'contributor'`;

let db: TestDatabase | undefined;
let older = "";
const teamId = randomUUID();
const otherTeam = randomUUID();
const admin = randomUUID();
const builder = randomUUID();
const plain = randomUUID();
const withFiles = randomUUID();
const selectedEmpty = randomUUID();
const otherWithFile = randomUUID();

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

async function projectFile(
  c: pg.Client,
  team: string,
  project: string,
  path: string,
  size: number,
) {
  await c.query(
    `INSERT INTO project_files (team_id, project_id, path, size_bytes, sha256, mime_type, blob_ref, added_by)
     VALUES ($1, $2, $3, $4, $5, 'text/plain', $6, $7)`,
    [
      team,
      project,
      path,
      size,
      "c".repeat(64),
      `teams/${team}/projects/${project}/files/${randomUUID()}`,
      admin,
    ],
  );
}

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
    for (const id of [admin, builder, plain]) {
      await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
        id,
        `${id}@upgrade.test`,
      ]);
    }
    await c.query(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, 'team_admin'), ($1, $3, 'builder'), ($1, $4, 'member'), ($5, $3, 'builder')`,
      [teamId, admin, builder, plain, otherTeam],
    );
    await c.query(
      `INSERT INTO team_invitations (team_id, email, role, invited_by, expires_at)
       VALUES ($1, 'b@upgrade.test', 'builder', $2, now() + interval '1 day')`,
      [teamId, admin],
    );
    await c.query(
      `INSERT INTO projects (team_id, id, slug, name, members_mode, created_by)
       VALUES ($1, $2, 'files', 'Files', 'team', $4), ($1, $3, 'empty', 'Empty', 'selected', $5),
              ($6, $7, 'other', 'Other', 'selected', $5)`,
      [teamId, withFiles, selectedEmpty, admin, builder, otherTeam, otherWithFile],
    );
    await c.query(
      `INSERT INTO project_members (team_id, project_id, user_id, role, added_by)
       VALUES ($1, $2, $3, 'owner', $3), ($1, $2, $4, 'member', $3),
              ($1, $5, $4, 'owner', $4), ($1, $5, $6, 'member', $4)`,
      [teamId, withFiles, admin, builder, selectedEmpty, plain],
    );
    await projectFile(c, teamId, withFiles, "docs/a.md", 10);
    await c.query(`UPDATE project_files SET added_at = now() - interval '3 days'`);
    await projectFile(c, teamId, withFiles, "data/b.csv", 32);
    await projectFile(c, otherTeam, otherWithFile, "x.txt", 7);
  });
  await runMigrations({ databaseUrl: database().ownerUrl, appRole: database().appRole });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("Workspaces migrations on upgrade (KOBE-577)", () => {
  it("MG1: renames builder to contributor in place, for members and invitations", async () => {
    const { rows: values } = await asAdmin((c) =>
      c.query(`SELECT unnest(enum_range(NULL::team_role))::text AS v`),
    );
    expect(values.map((r) => r.v)).toEqual(["team_admin", "contributor", "member"]);
    const { rows } = await asAdmin((c) =>
      c.query(
        `SELECT team_id, role::text AS role FROM team_members WHERE user_id = $1 ORDER BY team_id = $2`,
        [builder, teamId],
      ),
    );
    expect(rows.map((r) => r.role)).toEqual(["contributor", "contributor"]);
    const { rows: inv } = await asAdmin((c) =>
      c.query(`SELECT role::text AS role FROM team_invitations WHERE team_id = $1`, [teamId]),
    );
    expect(inv).toEqual([{ role: "contributor" }]);
  });

  it("MG2: visibility from members_mode, members_mode dropped", async () => {
    const { rows } = await asAdmin((c) =>
      c.query(`SELECT id, visibility FROM projects ORDER BY slug`),
    );
    expect(rows).toEqual([
      { id: selectedEmpty, visibility: "restricted" },
      { id: withFiles, visibility: "workspace" },
      { id: otherWithFile, visibility: "restricted" },
    ]);
    const { rows: cols } = await asAdmin((c) =>
      c.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'projects' AND column_name = 'members_mode'`,
      ),
    );
    expect(cols).toEqual([]);
  });

  it("MG3: member rows are editor, owners stay owner", async () => {
    const { rows } = await asAdmin((c) =>
      c.query(
        `SELECT project_id, user_id, role FROM project_members ORDER BY project_id, role DESC`,
      ),
    );
    const roles = rows.map((r) => `${r.project_id === withFiles ? "files" : "empty"}:${r.role}`);
    expect(roles.sort()).toEqual(["empty:editor", "empty:owner", "files:editor", "files:owner"]);
  });

  it("MG4: one Imported commit per project with files, its tree, head and counters", async () => {
    const { rows } = await asAdmin((c) =>
      c.query(
        `SELECT c.team_id, c.project_id, c.seq, c.parent_id, c.author_user_id, c.author_kind,
                c.thread_id, c.run_id, c.message, c.file_count, c.bytes::int AS bytes,
                p.head_commit_id = c.id AS is_head, p.live_bytes::int AS live_bytes,
                p.live_objects, p.history_bytes::int AS history_bytes, p.history_objects
           FROM project_commits c JOIN projects p ON p.team_id = c.team_id AND p.id = c.project_id
          ORDER BY c.bytes DESC`,
      ),
    );
    expect(rows).toEqual([
      {
        team_id: teamId,
        project_id: withFiles,
        seq: 1,
        parent_id: null,
        author_user_id: admin,
        author_kind: "user",
        thread_id: null,
        run_id: null,
        message: "Imported",
        file_count: 2,
        bytes: 42,
        is_head: true,
        live_bytes: 42,
        live_objects: 2,
        history_bytes: 0,
        history_objects: 0,
      },
      {
        team_id: otherTeam,
        project_id: otherWithFile,
        seq: 1,
        parent_id: null,
        author_user_id: builder,
        author_kind: "user",
        thread_id: null,
        run_id: null,
        message: "Imported",
        file_count: 1,
        bytes: 7,
        is_head: true,
        live_bytes: 7,
        live_objects: 1,
        history_bytes: 0,
        history_objects: 0,
      },
    ]);
    // Dated by the project's newest file.
    const { rows: dated } = await asAdmin((c) =>
      c.query(
        `SELECT bool_and(c.created_at = (SELECT max(f.added_at) FROM project_files f
                                          WHERE f.team_id = c.team_id AND f.project_id = c.project_id)) AS ok
           FROM project_commits c`,
      ),
    );
    expect(dated).toEqual([{ ok: true }]);
    const { rows: empty } = await asAdmin((c) =>
      c.query(`SELECT head_commit_id FROM projects WHERE id = $1`, [selectedEmpty]),
    );
    expect(empty).toEqual([{ head_commit_id: null }]);
    // The tree is project_files exactly (path, hash, key, size, type).
    const { rows: diff } = await asAdmin((c) =>
      c.query(
        `(SELECT f.team_id, f.path, f.sha256, f.blob_ref, f.size_bytes, f.mime_type FROM project_files f
          EXCEPT
          SELECT e.team_id, e.path, e.sha256, e.blob_ref, e.size_bytes, e.mime_type FROM project_tree_entries e)
         UNION ALL
         (SELECT e.team_id, e.path, e.sha256, e.blob_ref, e.size_bytes, e.mime_type FROM project_tree_entries e
          EXCEPT
          SELECT f.team_id, f.path, f.sha256, f.blob_ref, f.size_bytes, f.mime_type FROM project_files f)`,
      ),
    );
    expect(diff).toEqual([]);
    const { rows: n } = await asAdmin((c) =>
      c.query(`SELECT count(*)::int AS n FROM project_tree_entries`),
    );
    expect(n).toEqual([{ n: 3 }]);
  });

  it("leaves FORCE RLS on, so the app role sees only its own team's history", async () => {
    const { rows: force } = await asAdmin((c) =>
      c.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname IN ('projects', 'project_members', 'project_files', 'project_commits',
                            'project_tree_entries', 'project_checkouts')
          ORDER BY relname`,
      ),
    );
    expect(force.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
    expect(force).toHaveLength(6);
    const seen = await withClient(database().appUrl, async (c) => {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [teamId]);
      const { rows } = await c.query(
        `SELECT (SELECT count(*)::int FROM project_commits) AS commits,
                (SELECT count(*)::int FROM project_tree_entries) AS entries`,
      );
      await c.query("ROLLBACK");
      return rows[0];
    });
    expect(seen).toEqual({ commits: 1, entries: 2 });
  });
});
