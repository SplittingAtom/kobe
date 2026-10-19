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
 * KOBE-433 review (0153-0155) as an upgrade runs it: rows that were pinned, or drifted with a
 * proposal, count as approved; a drifted row with no proposal (new upstream) does not; then an
 * unapproved row can never be pinned, URIs are printable ASCII and `meta` is capped.
 */
const MARKER = 'ADD COLUMN "approved"';
const MIME = "text/html;profile=mcp-app";
const HEX = "a".repeat(64);

let db: TestDatabase | undefined;
let older = "";
const connectorId = randomUUID();

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

const insert = (c: pg.Client, uri: string, status: string, proposed: unknown, extra = "") =>
  c.query(
    `INSERT INTO connector_ui_resources
       (connector_id, uri, mime_type, html, sha256, pinned_hash, status, proposed${extra ? ", approved" : ""})
     VALUES ($1, $2, $3, 'x', $4, $4, $5, $6${extra ? `, ${extra}` : ""})`,
    [connectorId, uri, MIME, HEX, status, proposed],
  );

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await withClient(db.adminUrl, async (c) => {
    await c.query(
      `INSERT INTO connectors (id, name, url) VALUES ($1, 'apps', 'https://x.example/mcp')`,
      [connectorId],
    );
    await insert(c, "ui://c/pinned", "pinned", null);
    await insert(c, "ui://c/changed", "drifted", { invalid: "ui_resource_invalid" });
    await insert(c, "ui://c/new", "drifted", null);
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("connector ui resources approval on upgrade (KOBE-433 review)", () => {
  it("backfills approved and then holds the new checks", async () => {
    const { ownerUrl, appRole, appUrl } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    await withClient(appUrl, async (c) => {
      const { rows } = await c.query(
        `SELECT uri, approved FROM connector_ui_resources ORDER BY uri`,
      );
      expect(rows).toEqual([
        { uri: "ui://c/changed", approved: true },
        { uri: "ui://c/new", approved: false },
        { uri: "ui://c/pinned", approved: true },
      ]);
      await expect(
        c.query(`UPDATE connector_ui_resources SET status = 'pinned' WHERE uri = 'ui://c/new'`),
      ).rejects.toThrow(/connector_ui_resources_approved/);
      await expect(insert(c, "ui://c/a\u0001b", "drifted", null)).rejects.toThrow(
        /connector_ui_resources_uri/,
      );
      await expect(
        c.query(
          `UPDATE connector_ui_resources SET meta = jsonb_build_object('csp', repeat('x', 17000))
            WHERE uri = 'ui://c/new'`,
        ),
      ).rejects.toThrow(/connector_ui_resources_meta/);
      await insert(c, "ui://c/ok", "pinned", null, "true");
    });
  }, 120_000);
});
