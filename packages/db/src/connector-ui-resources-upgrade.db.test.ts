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
 * KOBE-433's migration as an upgrade runs it (the owner role): existing connectors keep working,
 * the app role can pin templates, the table's checks hold (ui:// only, the one MIME type, 512 KiB,
 * a proposal only on a drifted row), and deleting a connector deletes its templates.
 */
const MARKER = 'CREATE TABLE "connector_ui_resources"';
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

const insert = (c: pg.Client, overrides: Record<string, unknown> = {}) => {
  const row = {
    uri: `ui://c/${randomUUID()}`,
    mime_type: MIME,
    html: "<html></html>",
    status: "pinned",
    proposed: null as unknown,
    ...overrides,
  };
  return c.query(
    `INSERT INTO connector_ui_resources
       (connector_id, uri, mime_type, html, sha256, pinned_hash, status, proposed)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7)`,
    [connectorId, row.uri, row.mime_type, row.html, HEX, row.status, row.proposed],
  );
};

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await withClient(db.adminUrl, (c) =>
    c.query(`INSERT INTO connectors (id, name, url) VALUES ($1, 'apps', 'https://x.example/mcp')`, [
      connectorId,
    ]),
  );
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("connector ui resources on upgrade (KOBE-433)", () => {
  it("lets the app role pin templates under the table's checks", async () => {
    const { ownerUrl, appRole, appUrl } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    await withClient(appUrl, async (c) => {
      await insert(c, { uri: "ui://c/explorer" });
      await insert(c, { status: "drifted", proposed: { invalid: "ui_resource_invalid" } });
      await expect(insert(c, { uri: "https://x.example/app" })).rejects.toThrow(
        /connector_ui_resources_uri/,
      );
      await expect(insert(c, { mime_type: "text/html" })).rejects.toThrow(
        /connector_ui_resources_mime_type/,
      );
      await expect(insert(c, { html: "x".repeat(512 * 1024 + 1) })).rejects.toThrow(
        /connector_ui_resources_html/,
      );
      await expect(insert(c, { proposed: { invalid: "ui_resource_invalid" } })).rejects.toThrow(
        /connector_ui_resources_proposed/,
      );
      await expect(insert(c, { status: "approved" })).rejects.toThrow(
        /connector_ui_resources_status/,
      );
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM connector_ui_resources`);
      expect(rows).toEqual([{ n: 2 }]);
      await c.query(`DELETE FROM connectors WHERE id = $1`, [connectorId]);
      const after = await c.query(`SELECT count(*)::int AS n FROM connector_ui_resources`);
      expect(after.rows).toEqual([{ n: 0 }]);
    });
  }, 120_000);
});
