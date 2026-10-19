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
 * KOBE-431's backfill of `connectors.pinned_by` as an upgrade runs it (the owner role, no
 * superuser): a connector takes the user who last pinned or re-approved it according to the audit
 * log; one with no such event keeps the admin who registered it; a pin by the system actor or by a
 * user who no longer exists is skipped; an unpinned connector stays NULL.
 */
const MARKER = 'ADD COLUMN "pinned_by"';

let db: TestDatabase | undefined;
let older = "";
const ids = {
  creator: randomUUID(),
  pinner: randomUUID(),
  approver: randomUUID(),
  gone: randomUUID(),
  approvedLast: randomUUID(),
  pinnedOnly: randomUUID(),
  noEvents: randomUUID(),
  systemOnly: randomUUID(),
  goneUser: randomUUID(),
  unpinned: randomUUID(),
};
const HASH = "a".repeat(64);

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

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await withClient(db.adminUrl, async (c) => {
    for (const user of [ids.creator, ids.pinner, ids.approver]) {
      await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
        user,
        `${user}@upgrade.test`,
      ]);
    }
    const connector = (id: string, name: string, pinned: boolean) =>
      c.query(
        `INSERT INTO connectors (id, name, url, created_by, tools_hash)
         VALUES ($1, $2, 'https://mcp.example.test/mcp', $3, $4)`,
        [id, name, ids.creator, pinned ? HASH : null],
      );
    await connector(ids.approvedLast, "approved-last", true);
    await connector(ids.pinnedOnly, "pinned-only", true);
    await connector(ids.noEvents, "no-events", true);
    await connector(ids.systemOnly, "system-only", true);
    await connector(ids.goneUser, "gone-user", true);
    await connector(ids.unpinned, "unpinned", false);
    const event = (kind: "user" | "system", actor: string | null, action: string, id: string) =>
      c.query(
        `INSERT INTO audit_log (actor_kind, actor_id, action, target)
         VALUES ($1::audit_actor_kind, $2, $3, jsonb_build_object('connectorId', $4::text))`,
        [kind, actor, action, id],
      );
    await event("user", ids.pinner, "mcp.connector.pinned", ids.approvedLast);
    await event("user", ids.approver, "mcp.connector.reapproved", ids.approvedLast);
    await event("user", ids.pinner, "mcp.connector.pinned", ids.pinnedOnly);
    await event("user", ids.approver, "mcp.connector.updated", ids.pinnedOnly);
    await event("system", null, "mcp.connector.pinned", ids.systemOnly);
    await event("user", ids.gone, "mcp.connector.pinned", ids.goneUser);
    await event("user", ids.pinner, "mcp.connector.pinned", ids.unpinned);
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("connectors.pinned_by on upgrade (KOBE-431)", () => {
  it("takes the last pinning or approving user from the audit log, else the creator", async () => {
    const { ownerUrl, appRole, adminUrl } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    await withClient(adminUrl, async (c) => {
      const res = await c.query<{ id: string; pinned_by: string | null }>(
        `SELECT id, pinned_by FROM connectors`,
      );
      expect(Object.fromEntries(res.rows.map((r) => [r.id, r.pinned_by]))).toEqual({
        [ids.approvedLast]: ids.approver,
        [ids.pinnedOnly]: ids.pinner,
        [ids.noEvents]: ids.creator,
        [ids.systemOnly]: ids.creator,
        [ids.goneUser]: ids.creator,
        [ids.unpinned]: null,
      });
    });
  }, 120_000);
});
