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
 * KOBE-438's migrations (0157 table, 0158 RLS and legal hold) as an upgrade runs them (the owner
 * role) over an existing thread and run: the app role stores results only in its own team
 * (FORCE RLS), the checks hold (storage, sizes, origin), a thread delete cascades, a held
 * thread's results cannot be deleted, and TRUNCATE is refused while a hold is active.
 */
const MARKER = 'CREATE TABLE "thread_app_results"';
const HEX = "a".repeat(64);

let db: TestDatabase | undefined;
let older = "";
const teamId = randomUUID();
const otherTeam = randomUUID();
const userId = randomUUID();
const threadId = randomUUID();
const runId = randomUUID();
const requester = randomUUID();
const approver = randomUUID();

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

const insert = (c: pg.Client, overrides: Record<string, unknown> = {}) => {
  const row = {
    team_id: teamId,
    storage: "inline",
    result: JSON.stringify({ content: [] }),
    blob_ref: null as string | null,
    bytes: 14,
    entry_id: null as string | null,
    run_id: runId as string | null,
    ...overrides,
  };
  return c.query(
    `INSERT INTO thread_app_results
       (team_id, thread_id, run_id, pi_name, input_sha256, entry_id, connector_id, tool,
        template_uri, template_sha256, app_id, storage, result, blob_ref, bytes)
     VALUES ($1, $2, $3, CASE WHEN $3::uuid IS NULL THEN NULL ELSE 'mcp__c__open' END,
             CASE WHEN $3::uuid IS NULL THEN NULL ELSE $4 END, $5, $6, 'open',
             'ui://c/app', $4, $4, $7, $8::jsonb, $9, $10)
     RETURNING id`,
    [
      row.team_id,
      threadId,
      row.run_id,
      HEX,
      row.entry_id,
      randomUUID(),
      row.storage,
      row.result,
      row.blob_ref,
      row.bytes,
    ],
  );
};

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
    for (const id of [userId, requester, approver]) {
      await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
        id,
        `${id}@upgrade.test`,
      ]);
    }
    for (const id of [requester, approver]) {
      await c.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [id]);
    }
    await c.query(
      `INSERT INTO threads (id, team_id, owner_user_id, title) VALUES ($1, $2, $3, 'T')`,
      [threadId, teamId, userId],
    );
    await c.query(
      `INSERT INTO runs (id, team_id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, $3, 'user', 'running', now())`,
      [runId, teamId, threadId],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("thread_app_results on upgrade (KOBE-438)", () => {
  it("stores results for an existing thread, only in the caller's own team", async () => {
    const { ownerUrl, appRole } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    await asTeam(teamId, async (c) => {
      await insert(c);
      await insert(c, { storage: "blob", result: null, blob_ref: "teams/x/threads/y/apps/z" });
      await insert(c, { storage: "too_large", result: null, bytes: 5_000_000 });
      await insert(c, { run_id: null, entry_id: "app-card-1" });
      expect((await c.query(`SELECT count(*)::int AS n FROM thread_app_results`)).rows[0]).toEqual({
        n: 4,
      });
    });
    // FORCE RLS: another team sees nothing and cannot write this team's rows.
    await asTeam(otherTeam, async (c) => {
      expect((await c.query(`SELECT count(*)::int AS n FROM thread_app_results`)).rows[0]).toEqual({
        n: 0,
      });
      await expect(insert(c)).rejects.toThrow(/row-level security/);
    });
  });

  it("keeps the call's input up to 64 KiB (0159)", async () => {
    await asTeam(teamId, async (c) => {
      const { rows } = await insert(c);
      const id = (rows[0] as { id: string }).id;
      await c.query(`UPDATE thread_app_results SET input = $2::jsonb WHERE id = $1`, [
        id,
        JSON.stringify({ q: "tables" }),
      ]);
      await expect(
        c.query(`UPDATE thread_app_results SET input = $2::jsonb WHERE id = $1`, [
          id,
          JSON.stringify({ q: "x".repeat(70_000) }),
        ]),
      ).rejects.toThrow(/check constraint/);
    });
  });

  it("holds the table's checks", async () => {
    const bad: Record<string, unknown>[] = [
      { storage: "inline", result: null },
      { storage: "blob", result: JSON.stringify({}), blob_ref: null },
      { storage: "inline", bytes: 300_000 },
      { storage: "elsewhere" },
      { run_id: null },
    ];
    for (const overrides of bad) {
      await expect(asTeam(teamId, (c) => insert(c, overrides))).rejects.toThrow(/check constraint/);
    }
  });

  it("keeps a claimed result when its run goes (run_id cleared), and takes a fork's copy", async () => {
    const { adminUrl } = database();
    const run2 = randomUUID();
    await withClient(adminUrl, (c) =>
      c.query(
        `INSERT INTO runs (id, team_id, thread_id, trigger, status, started_at, ended_at)
         VALUES ($1, $2, $3, 'user', 'completed', now(), now())`,
        [run2, teamId, threadId],
      ),
    );
    const claimed = await asTeam(teamId, async (c) => {
      const { rows } = await insert(c, { run_id: run2 });
      const id = (rows[0] as { id: string }).id;
      await c.query(
        `UPDATE thread_app_results SET tool_call_id = 'tc1', prompt_entry_id = 'e1' WHERE id = $1`,
        [id],
      );
      // A fork's copy: placed by prompt entry and tool call, no run.
      await c.query(
        `INSERT INTO thread_app_results
           (team_id, thread_id, tool_call_id, prompt_entry_id, connector_id, tool, template_uri,
            template_sha256, app_id, storage, result, bytes)
         VALUES ($1, $2, 'tc1', 'e2', $3, 'open', 'ui://c/app', $4, $4, 'inline', '{}', 2)`,
        [teamId, threadId, randomUUID(), HEX],
      );
      return id;
    });
    await withClient(adminUrl, (c) => c.query(`DELETE FROM runs WHERE id = $1`, [run2]));
    await asTeam(teamId, async (c) => {
      const { rows } = await c.query(`SELECT run_id FROM thread_app_results WHERE id = $1`, [
        claimed,
      ]);
      expect(rows).toEqual([{ run_id: null }]);
    });
  });

  it("drops a run's unclaimed results (and queues their blobs) whenever the run ends (0160)", async () => {
    const { adminUrl } = database();
    for (const status of ["completed", "failed", "cancelled", "interrupted", "budget_stopped"]) {
      const thread = randomUUID();
      const run = randomUUID();
      await withClient(adminUrl, async (c) => {
        await c.query(
          `INSERT INTO threads (id, team_id, owner_user_id, title) VALUES ($1, $2, $3, 'T')`,
          [thread, teamId, userId],
        );
        await c.query(
          `INSERT INTO runs (id, team_id, thread_id, trigger, status, started_at)
           VALUES ($1, $2, $3, 'user', 'running', now())`,
          [run, teamId, thread],
        );
      });
      const key = `teams/${teamId}/threads/${thread}/apps/${run}`;
      await asTeam(teamId, async (c) => {
        const row = (overrides: Record<string, unknown>) =>
          c.query(
            `INSERT INTO thread_app_results
               (team_id, thread_id, run_id, pi_name, input_sha256, tool_call_id, connector_id, tool,
                template_uri, template_sha256, app_id, storage, result, blob_ref, bytes)
             VALUES ($1, $2, $3, 'mcp__c__open', $4, $5, $6, 'open', 'ui://c/app', $4, $4,
                     $7, $8::jsonb, $9, 10)`,
            [
              teamId,
              thread,
              run,
              HEX,
              overrides.tool_call_id ?? null,
              randomUUID(),
              overrides.storage ?? "inline",
              overrides.storage === "blob" ? null : "{}",
              overrides.storage === "blob" ? key : null,
            ],
          );
        await row({});
        await row({ storage: "blob" });
        await row({ tool_call_id: "tc-kept" });
        await c.query(`UPDATE runs SET status = $2, ended_at = now() WHERE id = $1`, [run, status]);
        const left = await c.query(
          `SELECT tool_call_id FROM thread_app_results WHERE run_id = $1`,
          [run],
        );
        expect(left.rows, status).toEqual([{ tool_call_id: "tc-kept" }]);
        const queued = await c.query(
          `SELECT thread_id FROM retention_blob_deletions WHERE team_id = $1 AND key = $2`,
          [teamId, key],
        );
        expect(queued.rows, status).toEqual([{ thread_id: thread }]);
      });
    }
  });

  it("refuses deleting a held thread's results and TRUNCATE during a hold; a thread delete cascades", async () => {
    const { adminUrl } = database();
    const hold = await withClient(adminUrl, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'case', $3)
         RETURNING id`,
        [teamId, userId, requester],
      );
      const id = rows[0]?.id ?? "";
      await c.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
        id,
        approver,
      ]);
      return id;
    });
    await expect(asTeam(teamId, (c) => c.query(`DELETE FROM thread_app_results`))).rejects.toThrow(
      /legal hold/,
    );
    await expect(
      withClient(adminUrl, (c) => c.query(`TRUNCATE thread_app_results`)),
    ).rejects.toThrow();
    await withClient(adminUrl, async (c) => {
      await c.query(
        `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(),
           release_reason = 'closed' WHERE id = $1`,
        [hold, requester],
      );
      await c.query(`UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`, [
        hold,
        approver,
      ]);
    });
    await withClient(adminUrl, (c) => c.query(`DELETE FROM threads WHERE id = $1`, [threadId]));
    await asTeam(teamId, async (c) => {
      expect(
        (
          await c.query(`SELECT count(*)::int AS n FROM thread_app_results WHERE thread_id = $1`, [
            threadId,
          ])
        ).rows[0],
      ).toEqual({
        n: 0,
      });
    });
  });
});
