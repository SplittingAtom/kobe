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
 * KOBE-454's migration as an upgrade runs it (the owner role, no BYPASSRLS): a site with a removed
 * (soft-deleted) connector that still holds its sealed site key and members' grants in two teams,
 * next to a live connector with the same. The removed connector's credentials are gone, the live
 * one's are kept, the removed row stays, FORCE RLS is back on, and a second run changes nothing.
 */
const MARKER = "KOBE-454: a removed connector";
const SEALED = "e1.k.x";

let db: TestDatabase | undefined;
let older = "";
const ids = {
  removed: randomUUID(),
  live: randomUUID(),
  teamA: randomUUID(),
  teamB: randomUUID(),
  user: randomUUID(),
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

const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};

const counts = (connectorId: string) =>
  withClient(database().adminUrl, async (c) => {
    const keys = await c.query(`SELECT 1 FROM connector_site_keys WHERE connector_id = $1`, [
      connectorId,
    ]);
    const grants = await c.query(`SELECT 1 FROM connector_grants WHERE connector_id = $1`, [
      connectorId,
    ]);
    return { keys: keys.rowCount, grants: grants.rowCount };
  });

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await withClient(db.adminUrl, async (c) => {
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      ids.user,
      `${ids.user}@upgrade.test`,
    ]);
    for (const team of [ids.teamA, ids.teamB]) {
      await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [
        team,
        `t${team.slice(0, 8)}`,
      ]);
    }
    for (const [id, name] of [
      [ids.removed, "gone"],
      [ids.live, "kept"],
    ] as const) {
      await c.query(
        `INSERT INTO connectors (id, name, url, auth_kind, credential_source)
         VALUES ($1, $2, 'https://x.example/mcp', 'api_key', 'site')`,
        [id, name],
      );
      await c.query(
        `INSERT INTO connector_site_keys (connector_id, sealed, key_id, url_sha256, hint)
         VALUES ($1, $2, 'k', repeat('a', 64), '••••')`,
        [id, SEALED],
      );
      for (const team of [ids.teamA, ids.teamB]) {
        await c.query(
          `INSERT INTO connector_grants (team_id, user_id, connector_id, kind, sealed, key_id, hint)
           VALUES ($1, $2, $3, 'api_key', $4, 'k', '••••')`,
          [team, ids.user, id, SEALED],
        );
      }
    }
    await c.query(`UPDATE connectors SET status = 'disabled', deleted_at = now() WHERE id = $1`, [
      ids.removed,
    ]);
  });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("removed connectors' credentials on upgrade (KOBE-454)", () => {
  it("deletes the removed connector's site key and grants, keeps the live one's", async () => {
    expect(await counts(ids.removed)).toEqual({ keys: 1, grants: 2 });
    const { ownerUrl, appRole, adminUrl } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    expect(await counts(ids.removed)).toEqual({ keys: 0, grants: 0 });
    expect(await counts(ids.live)).toEqual({ keys: 1, grants: 2 });
    await withClient(adminUrl, async (c) => {
      const row = await c.query(`SELECT deleted_at FROM connectors WHERE id = $1`, [ids.removed]);
      expect(row.rows[0].deleted_at).not.toBeNull();
      const rls = await c.query<{ relforcerowsecurity: boolean }>(
        `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'connector_grants'`,
      );
      expect(rls.rows).toEqual([{ relforcerowsecurity: true }]);
    });
    // Idempotent: running again is a no-op.
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    expect(await counts(ids.live)).toEqual({ keys: 1, grants: 2 });
  }, 180_000);
});
