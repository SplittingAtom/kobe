import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit, verifyAuditChain } from "./audit/index.js";
import { createDb } from "./client.js";
import { seedKobeBuiltinConnector } from "./connectors/builtin.js";
import { runMigrations } from "./migrate.js";
import { KOBE_BUILTIN_CONNECTOR_ID } from "./schema/index.js";
import {
  createTestDatabase,
  migrationsBefore,
  testServerUrl,
  type TestDatabase,
} from "./test-support/database.js";

/**
 * KOBE-618's migration as an upgrade runs it (the owner role) on a site shaped like gate1: a
 * registered connector already named `kobe`, enabled for a team, and a populated audit chain.
 * Registered rows keep `builtin` NULL and pass the new checks; the seed then falls back to
 * `kobe-builtin`; the chain still verifies with `via` rows appended after the upgrade.
 */
const MARKER = 'ADD COLUMN "builtin"';

let db: TestDatabase | undefined;
let older = "";
const ids = { user: randomUUID(), team: randomUUID(), kobe: randomUUID(), other: randomUUID() };

const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
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

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await withClient(db.adminUrl, async (c) => {
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', 'u@upgrade.test')`, [
      ids.user,
    ]);
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'upgrade-team', 'Upgrade')`, [
      ids.team,
    ]);
    for (const [id, name] of [
      [ids.kobe, "kobe"],
      [ids.other, "jira"],
    ] as const) {
      await c.query(
        `INSERT INTO connectors (id, name, url, created_by) VALUES ($1, $2, 'https://mcp.example.test/mcp', $3)`,
        [id, name, ids.user],
      );
      await c.query(
        `INSERT INTO team_connectors (team_id, connector_id, enabled_by) VALUES ($1, $2, $3)`,
        [ids.team, id, ids.user],
      );
    }
  });
  const app = createDb(db.appUrl);
  for (let i = 0; i < 3; i++) {
    await app.db.transaction((tx) =>
      audit(tx, { action: "auth.sign_out", actor: { kind: "user", id: ids.user }, target: {} }),
    );
  }
  await app.close();
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("the built-in connector on upgrade (KOBE-618)", () => {
  it("leaves registered connectors alone, seeds kobe-builtin, and the chain verifies", async () => {
    const { ownerUrl, appRole, appUrl, adminUrl } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    // Running the migrations again is a no-op (the migrate job of every release does this).
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    const app = createDb(appUrl);
    try {
      expect(await seedKobeBuiltinConnector(app.db)).toEqual({
        outcome: "seeded",
        name: "kobe-builtin",
        fallback: true,
      });
      expect(await seedKobeBuiltinConnector(app.db)).toEqual({
        outcome: "present",
        name: "kobe-builtin",
      });
      await app.db.transaction((tx) =>
        audit(tx, {
          action: "auth.sign_out",
          actor: { kind: "user", id: ids.user },
          target: {},
          via: { kind: "agent", threadId: randomUUID(), runId: randomUUID(), toolCallId: "t1" },
        }),
      );
      expect((await verifyAuditChain(app.db)).ok).toBe(true);
    } finally {
      await app.close();
    }
    await withClient(adminUrl, async (c) => {
      const res = await c.query<{ id: string; name: string; builtin: string | null }>(
        `SELECT id, name, builtin FROM connectors ORDER BY name`,
      );
      expect(res.rows).toEqual([
        { id: ids.other, name: "jira", builtin: null },
        { id: ids.kobe, name: "kobe", builtin: null },
        { id: KOBE_BUILTIN_CONNECTOR_ID, name: "kobe-builtin", builtin: "kobe" },
      ]);
      // The built-in needs no team row: teams keep exactly their own enablements.
      const enabled = await c.query(`SELECT count(*)::int AS n FROM team_connectors`);
      expect(enabled.rows[0]).toEqual({ n: 2 });
    });
  }, 120_000);
});
