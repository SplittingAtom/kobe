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
 * SSO security review (findings 8 and 10): 0212 adds `users.setup_owner` and
 * `users.deactivated_via`. The setup Owner is backfilled from the setup audit event (even after an
 * ownership transfer), else from the current Owner; deactivations made before are an admin's.
 */
const BEFORE_0212 = 'ADD COLUMN "deactivated_via"';

const dbs: TestDatabase[] = [];
let folder = "";

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function oldSite(): Promise<TestDatabase> {
  const db = await createTestDatabase(testServerUrl(), { migrationsFolder: folder });
  dbs.push(db);
  return db;
}

const addUser = (c: pg.Client, id: string, deactivated = false) =>
  c.query(
    `INSERT INTO users (id, name, email, deactivated_at) VALUES ($1, 'U', $2, ${deactivated ? "now()" : "NULL"})`,
    [id, `${id}@upgrade.test`],
  );

const flags = (db: TestDatabase) =>
  withClient(db.adminUrl, async (c) => {
    const r = await c.query<{ id: string; setup_owner: boolean; deactivated_via: string | null }>(
      `SELECT id, setup_owner, deactivated_via FROM users`,
    );
    return new Map(r.rows.map((row) => [row.id, row]));
  });

beforeAll(() => {
  folder = migrationsBefore(BEFORE_0212);
});

afterAll(async () => {
  for (const db of dbs) await db.drop();
  if (folder) rmSync(folder, { recursive: true, force: true });
});

describe("0212 backfill (SSO review findings 8, 10)", () => {
  it("flags the setup Owner from the setup event even after a transfer", async () => {
    const db = await oldSite();
    const setup = randomUUID();
    const owner = randomUUID();
    const gone = randomUUID();
    await withClient(db.adminUrl, async (c) => {
      await addUser(c, setup);
      await addUser(c, owner);
      await addUser(c, gone, true);
      await c.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'owner')`, [owner]);
      await c.query(
        `INSERT INTO audit_log (actor_kind, actor_id, action, target)
         VALUES ('user', $1, 'identity.setup.completed', $2)`,
        [setup, JSON.stringify({ ownerUserId: setup })],
      );
    });
    await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
    const rows = await flags(db);
    expect(rows.get(setup)).toMatchObject({ setup_owner: true, deactivated_via: null });
    expect(rows.get(owner)).toMatchObject({ setup_owner: false });
    expect(rows.get(gone)).toMatchObject({ setup_owner: false, deactivated_via: "admin" });
  }, 180_000);

  it("falls back to the current Owner when no setup event exists", async () => {
    const db = await oldSite();
    const owner = randomUUID();
    const other = randomUUID();
    await withClient(db.adminUrl, async (c) => {
      await addUser(c, owner);
      await addUser(c, other);
      await c.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'owner')`, [owner]);
    });
    await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
    const rows = await flags(db);
    expect(rows.get(owner)?.setup_owner).toBe(true);
    expect(rows.get(other)?.setup_owner).toBe(false);
  }, 180_000);
});
