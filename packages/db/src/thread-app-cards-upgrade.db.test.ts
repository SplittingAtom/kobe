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
 * KOBE-440 (0162) as an upgrade runs it: app cards a member launched during a run wait as
 * `thread_app_results` rows with their card text and who opened them (`queued_at` set) until the
 * run ends. Existing rows keep NULLs; only an app card row can wait; the text is capped; a queued
 * row needs its text; deleting the member clears `opened_by` only.
 */
const MARKER = 'ADD COLUMN "queued_at"';
const HEX = "a".repeat(64);

let db: TestDatabase | undefined;
let older = "";
const teamId = randomUUID();
const userId = randomUUID();
const threadId = randomUUID();
const existing = randomUUID();

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

/** As the app role inside the team's transaction. */
async function asTeam<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  return withClient(database().appUrl, async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [teamId]);
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
}

function card(c: pg.Client, fields: Record<string, unknown>) {
  const row: Record<string, unknown> = {
    entry_id: `ka-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    ...fields,
  };
  return c.query(
    `INSERT INTO thread_app_results
       (team_id, thread_id, entry_id, connector_id, tool, template_uri, template_sha256, app_id,
        storage, result, bytes, card_text, opened_by, queued_at)
     VALUES ($1, $2, $3, $4, 'open', 'ui://c/app', $5, $5, 'inline', '{}'::jsonb, 2,
             $6, $7, $8)
     RETURNING id`,
    [
      teamId,
      threadId,
      row.entry_id,
      randomUUID(),
      HEX,
      row.card_text ?? null,
      row.opened_by ?? null,
      row.queued_at ?? null,
    ],
  );
}

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await withClient(db.adminUrl, async (c) => {
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [
      teamId,
      `t${teamId.slice(0, 8)}`,
    ]);
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      userId,
      `${userId}@upgrade.test`,
    ]);
    await c.query(
      `INSERT INTO threads (id, team_id, owner_user_id, title) VALUES ($1, $2, $3, 'T')`,
      [threadId, teamId, userId],
    );
    await c.query(
      `INSERT INTO thread_app_results
         (team_id, id, thread_id, entry_id, connector_id, tool, template_uri, template_sha256,
          app_id, storage, result, bytes)
       VALUES ($1, $2, $3, 'ka-000000000000000000000001', $4, 'open', 'ui://c/app', $5, $5,
               'inline', '{}'::jsonb, 2)`,
      [teamId, existing, threadId, randomUUID(), HEX],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("queued app cards on upgrade (KOBE-440, 0162)", () => {
  it("keeps existing rows as inserted cards", async () => {
    const { ownerUrl, appRole } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    await asTeam(async (c) => {
      const { rows } = await c.query(
        `SELECT card_text, opened_by, queued_at FROM thread_app_results WHERE id = $1`,
        [existing],
      );
      expect(rows).toEqual([{ card_text: null, opened_by: null, queued_at: null }]);
    });
  });

  it("lets a launched card wait with its text, and insert later", async () => {
    await asTeam(async (c) => {
      const { rows } = await card(c, {
        card_text: "The app-card block…",
        opened_by: userId,
        queued_at: new Date().toISOString(),
      });
      const id = (rows[0] as { id: string }).id;
      await c.query(
        `UPDATE thread_app_results SET queued_at = NULL, card_text = NULL WHERE id = $1`,
        [id],
      );
    });
  });

  it("refuses a waiting row that is not a card, has no text, or a text over 16 KiB", async () => {
    const now = new Date().toISOString();
    for (const bad of [
      { queued_at: now, card_text: null },
      { queued_at: now, card_text: "x".repeat(16 * 1024 + 1) },
    ]) {
      await expect(asTeam((c) => card(c, bad))).rejects.toThrow(/check constraint/);
    }
    await expect(
      asTeam((c) =>
        c.query(
          `INSERT INTO thread_app_results
             (team_id, thread_id, tool_call_id, connector_id, tool, template_uri,
              template_sha256, app_id, storage, bytes, card_text, queued_at)
           VALUES ($1, $2, 'tc1', $3, 'open', 'ui://c/app', $4, $4, 'too_large', 2,
                   'text', now())`,
          [teamId, threadId, randomUUID(), HEX],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("clears only opened_by when the member is deleted", async () => {
    const gone = randomUUID();
    await withClient(database().adminUrl, (c) =>
      c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'G', $2)`, [
        gone,
        `${gone}@upgrade.test`,
      ]),
    );
    const id = await asTeam(async (c) => {
      const { rows } = await card(c, { opened_by: gone });
      return (rows[0] as { id: string }).id;
    });
    await withClient(database().adminUrl, (c) =>
      c.query(`DELETE FROM users WHERE id = $1`, [gone]),
    );
    await asTeam(async (c) => {
      const { rows } = await c.query(`SELECT opened_by FROM thread_app_results WHERE id = $1`, [
        id,
      ]);
      expect(rows).toEqual([{ opened_by: null }]);
    });
  });
});
