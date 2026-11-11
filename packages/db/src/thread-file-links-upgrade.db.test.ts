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
 * KOBE-610's migrations (0205 table, 0206 RLS and triggers) as an upgrade runs them (the owner
 * role) over a populated database (threads, workspace manifest, a project with files): the table
 * starts empty and team-confined (FORCE RLS), holds its scope and path checks, and the triggers
 * follow moves (a tombstone's `moved_to`, a folder in the move journal, merging into an existing
 * link) and deletes (workspace and project files), while deleting a project takes its links along.
 */
const MARKER = 'CREATE TABLE "thread_file_links"';

let db: TestDatabase | undefined;
let older = "";
const teamId = randomUUID();
const otherTeam = randomUUID();
const userId = randomUUID();
const threadId = randomUUID();
const otherThread = randomUUID();
const projectId = randomUUID();
const SHA = "a".repeat(64);

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

/** As the app role inside `team`'s transaction. */
async function asTeam<T>(team: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  return withClient(database().appUrl, async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [team]);
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
}

async function code(c: pg.Client, fn: () => Promise<unknown>): Promise<string | undefined> {
  await c.query("SAVEPOINT probe");
  try {
    await fn();
    await c.query("RELEASE SAVEPOINT probe");
    return undefined;
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT probe");
    return (err as { code?: string }).code;
  }
}

const link = (
  c: pg.Client,
  path: string,
  access: "read" | "write",
  scope: { owner?: string; project?: string } = { owner: userId },
  count = 1,
) =>
  c.query(
    `INSERT INTO thread_file_links (team_id, thread_id, owner_user_id, project_id, path, access, count)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [teamId, threadId, scope.owner ?? null, scope.project ?? null, path, access, count],
  );

let rev = 100;
/** A manifest write as workspace sync does it: live, a tombstone, or a tombstone that moved. */
const manifest = (c: pg.Client, path: string, state: "live" | "deleted", movedTo?: string) =>
  c.query(
    `INSERT INTO workspace_files
       (team_id, user_id, path, rev, deleted, sha256, blob_key, size, mtime_ms, origin, moved_to)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 0, 'sandbox', $8)
     ON CONFLICT (team_id, user_id, path) DO UPDATE SET rev = EXCLUDED.rev,
       deleted = EXCLUDED.deleted, sha256 = EXCLUDED.sha256, blob_key = EXCLUDED.blob_key,
       moved_to = EXCLUDED.moved_to`,
    [
      teamId,
      userId,
      path,
      (rev += 1),
      state === "deleted",
      state === "live" ? SHA : null,
      state === "live" ? "k" : null,
      movedTo ?? null,
    ],
  );

type LinkRow = { path: string; access: string; count: number; deleted: boolean };
const links = async (c: pg.Client, where = "owner_user_id IS NOT NULL"): Promise<LinkRow[]> =>
  (
    await c.query<LinkRow>(
      `SELECT path, access, count, deleted_at IS NOT NULL AS deleted FROM thread_file_links
        WHERE ${where} ORDER BY path, access`,
    )
  ).rows;

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await withClient(db.adminUrl, async (c) => {
    for (const id of [teamId, otherTeam]) {
      await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [
        id,
        `t${id.slice(0, 8)}`,
      ]);
    }
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      userId,
      `${userId}@upgrade.test`,
    ]);
    await c.query(
      `INSERT INTO threads (id, team_id, owner_user_id, title)
       VALUES ($1, $3, $4, 'mine'), ($2, $5, $4, 'other')`,
      [threadId, otherThread, teamId, userId, otherTeam],
    );
    await c.query(
      `INSERT INTO workspace_files
         (team_id, user_id, path, rev, deleted, sha256, blob_key, size, mtime_ms, origin)
       VALUES ($1, $2, 'notes/a.md', 1, false, $3, 'k', 1, 0, 'sandbox')`,
      [teamId, userId, SHA],
    );
    await c.query(
      `INSERT INTO projects (team_id, id, slug, name, created_by) VALUES ($1, $2, 'docs', 'Docs', $3)`,
      [teamId, projectId, userId],
    );
    await c.query(
      `INSERT INTO project_files (team_id, project_id, path, size_bytes, sha256, mime_type, blob_ref, added_by)
       VALUES ($1, $2, 'guide.md', 1, $3, 'text/markdown', 'p', $4)`,
      [teamId, projectId, SHA, userId],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("thread_file_links on upgrade (KOBE-610)", () => {
  it("starts empty and keeps links in the caller's own team", async () => {
    const { ownerUrl, appRole } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    const { rows } = await withClient(database().adminUrl, (c) =>
      c.query(`SELECT count(*)::int AS n FROM thread_file_links`),
    );
    expect(rows).toEqual([{ n: 0 }]);
    await asTeam(teamId, (c) => link(c, "notes/a.md", "read"));
    await asTeam(otherTeam, async (c) => {
      expect(await links(c, "true")).toEqual([]);
      await expect(link(c, "notes/b.md", "read")).rejects.toThrow(/row-level security/);
    });
  });

  it("holds the scope, path and access checks and the one-row-per-use key", async () => {
    await asTeam(teamId, async (c) => {
      expect(await code(c, () => link(c, "x", "read", {}))).toBe("23514");
      expect(await code(c, () => link(c, "x", "read", { owner: userId, project: projectId }))).toBe(
        "23514",
      );
      for (const bad of ["/abs", "dir/", "a//b", ""]) {
        expect(await code(c, () => link(c, bad, "read"))).toBe("23514");
      }
      expect(
        await code(c, () =>
          c.query(
            `INSERT INTO thread_file_links (team_id, thread_id, owner_user_id, path, access)
             VALUES ($1, $2, $3, 'y', 'execute')`,
            [teamId, threadId, userId],
          ),
        ),
      ).toBe("23514");
      // NULLS NOT DISTINCT: the same (thread, owner, path, access) twice is one row.
      expect(await code(c, () => link(c, "notes/a.md", "read"))).toBe("23505");
      // Another team's thread never resolves (the key includes team_id).
      expect(
        await code(c, () =>
          c.query(
            `INSERT INTO thread_file_links (team_id, thread_id, owner_user_id, path, access)
             VALUES ($1, $2, $3, 'z', 'read')`,
            [teamId, otherThread, userId],
          ),
        ),
      ).toBe("23503");
    });
  });

  it("marks a deleted workspace file's links and clears the mark when it is back", async () => {
    await asTeam(teamId, async (c) => {
      await manifest(c, "notes/a.md", "deleted");
      expect(await links(c)).toEqual([
        { path: "notes/a.md", access: "read", count: 1, deleted: true },
      ]);
      await manifest(c, "notes/a.md", "live");
      expect(await links(c)).toEqual([
        { path: "notes/a.md", access: "read", count: 1, deleted: false },
      ]);
    });
  });

  it("follows a file move (moved_to) and merges into a link already at the new path", async () => {
    await asTeam(teamId, async (c) => {
      await link(c, "notes/b.md", "read", { owner: userId }, 2);
      await manifest(c, "notes/b.md", "live");
      // The thread already read notes/a.md; b.md moves onto a's path after a is gone.
      await manifest(c, "notes/a.md", "deleted");
      await manifest(c, "notes/b.md", "deleted", "notes/a.md");
      await manifest(c, "notes/a.md", "live");
      expect(await links(c)).toEqual([
        { path: "notes/a.md", access: "read", count: 3, deleted: false },
      ]);
    });
  });

  it("follows a folder move from the move journal, the folder's own link included", async () => {
    await asTeam(teamId, async (c) => {
      await link(c, "notes", "read");
      await link(c, "notes/a.md", "write");
      await link(c, "notesx/keep.md", "read");
      await c.query(
        `INSERT INTO workspace_moves (team_id, user_id, rev, from_path, to_path, type, files, bytes)
         VALUES ($1, $2, $3, 'notes', 'archive/notes', 'dir', 1, 1)`,
        [teamId, userId, (rev += 1)],
      );
      expect((await links(c)).map((l) => `${l.path}:${l.access}:${l.count}`)).toEqual([
        "archive/notes:read:1",
        "archive/notes/a.md:read:3",
        "archive/notes/a.md:write:1",
        "notesx/keep.md:read:1",
      ]);
    });
  });

  it("marks project file links deleted with the file, and a project delete takes them along", async () => {
    await asTeam(teamId, async (c) => {
      await link(c, "guide.md", "write", { project: projectId });
      await c.query(`DELETE FROM project_files WHERE team_id = $1 AND path = 'guide.md'`, [teamId]);
      expect(await links(c, "project_id IS NOT NULL")).toEqual([
        { path: "guide.md", access: "write", count: 1, deleted: true },
      ]);
      await c.query(
        `INSERT INTO project_files (team_id, project_id, path, size_bytes, sha256, mime_type, blob_ref, added_by)
         VALUES ($1, $2, 'guide.md', 1, $3, 'text/markdown', 'p', $4)`,
        [teamId, projectId, SHA, userId],
      );
      expect((await links(c, "project_id IS NOT NULL"))[0]?.deleted).toBe(false);
      await c.query(`DELETE FROM projects WHERE team_id = $1 AND id = $2`, [teamId, projectId]);
      expect(await links(c, "project_id IS NOT NULL")).toEqual([]);
    });
  });

  it("goes with its thread", async () => {
    await asTeam(teamId, async (c) => {
      await c.query(`DELETE FROM threads WHERE team_id = $1 AND id = $2`, [teamId, threadId]);
      expect(await links(c, "true")).toEqual([]);
    });
  });
});
