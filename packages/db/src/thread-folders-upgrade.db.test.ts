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
 * KOBE-534's migrations (0186 table and column, 0187 RLS, name key, tree trigger, thread key,
 * check and index) as an upgrade runs them (the owner role) over a populated database: existing
 * threads stay unfiled, the app role keeps folders in its own team (FORCE RLS), the tree trigger
 * refuses depth 4 and cycles even through direct SQL, and deleting a folder cascades to its
 * subfolders and nulls its threads' folder_id (Trash included).
 */
const MARKER = 'CREATE TABLE "thread_folders"';

let db: TestDatabase | undefined;
let older = "";
const teamId = randomUUID();
const otherTeam = randomUUID();
const userId = randomUUID();
const liveThread = randomUUID();
const trashedThread = randomUUID();
const testThread = randomUUID();
const otherThread = randomUUID();

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

async function folder(
  c: pg.Client,
  name: string,
  parentId: string | null = null,
  team = teamId,
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO thread_folders (team_id, parent_id, name, created_by) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [team, parentId, name, userId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no folder");
  return id;
}

/** The SQLSTATE `fn` fails with (inside a savepoint, so the transaction goes on), or undefined. */
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

const move = (c: pg.Client, id: string, parent: string | null) =>
  c.query(`UPDATE thread_folders SET parent_id = $2 WHERE team_id = $3 AND id = $1`, [
    id,
    parent,
    teamId,
  ]);

const file = (c: pg.Client, thread: string, folderId: string | null) =>
  c.query(`UPDATE threads SET folder_id = $2 WHERE team_id = $3 AND id = $1`, [
    thread,
    folderId,
    teamId,
  ]);

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
      `INSERT INTO threads (id, team_id, owner_user_id, title, deleted_at, is_test)
       VALUES ($1, $5, $6, 'live', NULL, false), ($2, $5, $6, 'trashed', now(), false),
              ($3, $5, $6, 'test', NULL, true), ($4, $7, $6, 'other', NULL, false)`,
      [liveThread, trashedThread, testThread, otherThread, teamId, userId, otherTeam],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("thread folders on upgrade (KOBE-534)", () => {
  it("leaves existing threads unfiled and keeps folders in the caller's own team", async () => {
    const { ownerUrl, appRole } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    const { rows } = await withClient(database().adminUrl, (c) =>
      c.query(`SELECT count(*)::int AS n FROM threads WHERE folder_id IS NOT NULL`),
    );
    expect(rows).toEqual([{ n: 0 }]);
    await asTeam(teamId, (c) => folder(c, "Mine"));
    await asTeam(otherTeam, async (c) => {
      expect((await c.query(`SELECT count(*)::int AS n FROM thread_folders`)).rows).toEqual([
        { n: 0 },
      ]);
      await expect(folder(c, "Theirs", null, teamId)).rejects.toThrow(/row-level security/);
    });
  });

  it("holds the name check and the sibling key ignoring case (top level included)", async () => {
    await asTeam(teamId, async (c) => {
      for (const bad of ["", " padded", "x".repeat(81)]) {
        expect(await code(c, () => folder(c, bad))).toBe("23514");
      }
      expect(await code(c, () => folder(c, "MINE"))).toBe("23505");
      const parent = await folder(c, "Parent");
      await folder(c, "Mine", parent); // another parent: allowed
      expect(await code(c, () => folder(c, "mine", parent))).toBe("23505");
    });
    // The same name in another team is fine.
    await asTeam(otherTeam, (c) => folder(c, "Mine", null, otherTeam));
  });

  it("refuses a fourth level and every cycle, even through direct SQL", async () => {
    await asTeam(teamId, async (c) => {
      const a = await folder(c, "A");
      const b = await folder(c, "B", a);
      const cc = await folder(c, "C", b);
      expect(await code(c, () => folder(c, "D", cc))).toBe("KF001");
      // Self and descendant parents are cycles.
      expect(await code(c, () => move(c, a, a))).toBe("KF002");
      expect(await code(c, () => move(c, a, cc))).toBe("KF002");
      // A moved subtree counts: B (with child C) under a second-level folder would reach 4.
      const x = await folder(c, "X");
      const y = await folder(c, "Y", x);
      expect(await code(c, () => move(c, b, y))).toBe("KF001");
      // ...but under a top-level folder it fits (depth 3), and back to the top level too.
      await move(c, b, x);
      await move(c, b, null);
      // Renames and position changes never trip the trigger.
      await c.query(`UPDATE thread_folders SET name = 'C2', position = 3 WHERE id = $1`, [cc]);
    });
  });

  it("files threads in their own team only, never a test thread", async () => {
    const theirs = await asTeam(otherTeam, (c) => folder(c, "Theirs", null, otherTeam));
    await asTeam(teamId, async (c) => {
      const f = await folder(c, "Files");
      await file(c, liveThread, f);
      expect(await code(c, () => file(c, testThread, f))).toBe("23514");
      // Another team's folder id never resolves (the key includes team_id).
      expect(await code(c, () => file(c, liveThread, theirs))).toBe("23503");
    });
  });

  it("deleting a folder cascades to its subfolders and nulls its threads' folder_id", async () => {
    const { top, sub, subsub } = await asTeam(teamId, async (c) => {
      const top = await folder(c, "Doomed");
      const sub = await folder(c, "Sub", top);
      const subsub = await folder(c, "SubSub", sub);
      await file(c, liveThread, subsub);
      await file(c, trashedThread, sub);
      return { top, sub, subsub };
    });
    await asTeam(teamId, async (c) => {
      await c.query(`DELETE FROM thread_folders WHERE team_id = $1 AND id = $2`, [teamId, top]);
      const left = await c.query(
        `SELECT count(*)::int AS n FROM thread_folders WHERE team_id = $1 AND id = ANY($2::uuid[])`,
        [teamId, [top, sub, subsub]],
      );
      expect(left.rows).toEqual([{ n: 0 }]);
      const threads = await c.query(
        `SELECT id, folder_id, deleted_at IS NOT NULL AS trashed FROM threads
          WHERE team_id = $1 AND id = ANY($2::uuid[]) ORDER BY title`,
        [teamId, [liveThread, trashedThread]],
      );
      expect(threads.rows).toEqual([
        { id: liveThread, folder_id: null, trashed: false },
        { id: trashedThread, folder_id: null, trashed: true },
      ]);
    });
  });

  it("has the partial index for a folder's threads", async () => {
    const { rows } = await withClient(database().adminUrl, (c) =>
      c.query<{ def: string }>(
        `SELECT pg_get_indexdef(indexrelid) AS def FROM pg_index
          WHERE indexrelid = 'threads_folder_idx'::regclass`,
      ),
    );
    expect(rows[0]?.def).toMatch(
      /\(team_id, folder_id, last_activity_at DESC, id DESC\) WHERE \(\(folder_id IS NOT NULL\) AND \(deleted_at IS NULL\)\)/,
    );
  });
});
