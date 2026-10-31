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
 * KOBE-531 as an upgrade runs it: `placement` arrives with default `chat`, and every app the
 * KOBE-460 name rule ("Picker" in the display title, any case) put in the rail becomes `rail`.
 */
const MARKER = 'ADD COLUMN "placement"';
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

const tool = (name: string, uri: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: "",
  input_schema: { type: "object" },
  annotations: {},
  status: "pinned",
  ui: { resource_uri: uri },
  ...extra,
});

/** uri → html of each fixture row, and the placement the upgrade must give it. */
const ROWS: readonly { uri: string; html: string; want: string }[] = [
  { uri: "ui://c/head", html: "<html><head><TITLE>Lakehouse picker</TITLE>", want: "rail" },
  { uri: "ui://c/tool-title", html: "<title>Lake</title>", want: "rail" },
  { uri: "ui://c/annotation", html: "x", want: "rail" },
  { uri: "ui://c/name", html: "x", want: "rail" },
  { uri: "ui://c/explorer", html: "<title>Lakehouse Explorer</title>", want: "chat" },
  { uri: "ui://c/body", html: "<html><body><p>Pick a table</p></body>", want: "chat" },
  { uri: "ui://c/no-tool", html: "x", want: "chat" },
];

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  const snapshot = [
    tool("open_lake", "ui://c/tool-title", { title: "Table PICKER" }),
    tool("open_annotated", "ui://c/annotation", { annotations: { title: "Column picker" } }),
    tool("lakehouse_picker", "ui://c/name"),
    tool("explore", "ui://c/explorer", { title: "Explorer" }),
    tool("body", "ui://c/body"),
    tool("other_picker", "ui://c/elsewhere"),
  ];
  await withClient(db.adminUrl, async (c) => {
    await c.query(
      `INSERT INTO connectors (id, name, url, tools_snapshot)
       VALUES ($1, 'apps', 'https://x.example/mcp', $2::jsonb)`,
      [connectorId, JSON.stringify(snapshot)],
    );
    for (const r of ROWS) {
      await c.query(
        `INSERT INTO connector_ui_resources
           (connector_id, uri, mime_type, html, sha256, pinned_hash, status, approved)
         VALUES ($1, $2, $3, $4, $5, $5, 'pinned', true)`,
        [connectorId, r.uri, MIME, r.html, HEX],
      );
    }
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("connector ui resources placement on upgrade (KOBE-531)", () => {
  it("makes picker-named apps rail and leaves the rest chat", async () => {
    const { ownerUrl, appRole, appUrl } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    await withClient(appUrl, async (c) => {
      const { rows } = await c.query<{ uri: string; placement: string }>(
        `SELECT uri, placement FROM connector_ui_resources ORDER BY uri`,
      );
      expect(Object.fromEntries(rows.map((r) => [r.uri, r.placement]))).toEqual(
        Object.fromEntries(ROWS.map((r) => [r.uri, r.want])),
      );
    });
  }, 120_000);

  it("defaults new rows to chat and refuses an unknown placement", async () => {
    await withClient(database().appUrl, async (c) => {
      await c.query(
        `INSERT INTO connector_ui_resources
           (connector_id, uri, mime_type, html, sha256, pinned_hash, status)
         VALUES ($1, 'ui://c/new', $2, 'x', $3, $3, 'drifted')`,
        [connectorId, MIME, HEX],
      );
      const { rows } = await c.query(
        `SELECT placement FROM connector_ui_resources WHERE uri = 'ui://c/new'`,
      );
      expect(rows).toEqual([{ placement: "chat" }]);
      await expect(
        c.query(`UPDATE connector_ui_resources SET placement = 'side' WHERE uri = 'ui://c/new'`),
      ).rejects.toThrow(/connector_ui_resources_placement/);
      await c.query(
        `UPDATE connector_ui_resources SET placement = 'artifacts' WHERE uri = 'ui://c/new'`,
      );
    });
  }, 120_000);
});
