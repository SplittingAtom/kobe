import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb } from "./client.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-289: remember scopes on `tool_rules` (team isolation: probe.db.test). User rules carry a
 * scope, thread and run rules name exactly their thread or run and go with it, and the backfill
 * gives KOBE-37's rules the scope their expiry says.
 */
const dir = fileURLToPath(new URL("../drizzle/", import.meta.url));
const file = readdirSync(dir).find((f) => /^\d{4}_tool_rules_remember_scopes\.sql$/.test(f));
const migrationSql = readFileSync(`${dir}${file ?? "missing.sql"}`, "utf8").replaceAll(
  "--> statement-breakpoint",
  "",
);

const app = createDb(inject("appUrl"), { max: 2 });
const admin = new pg.Client({ connectionString: inject("adminUrl") });
let teamId = "";
let userId = "";
let threadId = "";
let runId = "";

beforeAll(async () => {
  await admin.connect();
  teamId = randomUUID();
  userId = randomUUID();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'R')`, [
    teamId,
    `rr-${teamId.slice(0, 8)}`,
  ]);
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, 'R', $2)`, [
    userId,
    `${userId}@remember.test`,
  ]);
  await admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [
    teamId,
    userId,
  ]);
  ({ threadId, runId } = await threadAndRun());
});

afterAll(async () => {
  await admin.end();
  await app.close();
});

async function threadAndRun(): Promise<{ threadId: string; runId: string }> {
  const t = await admin.query<{ id: string }>(
    `INSERT INTO threads (team_id, owner_user_id, title) VALUES ($1, $2, 'R') RETURNING id`,
    [teamId, userId],
  );
  const thread = t.rows[0]?.id ?? "";
  const r = await admin.query<{ id: string }>(
    `INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
     VALUES ($1, $2, 'user', 'running', now()) RETURNING id`,
    [teamId, thread],
  );
  return { threadId: thread, runId: r.rows[0]?.id ?? "" };
}

interface Row {
  readonly scope?: "team" | "user";
  readonly rememberScope?: string | null;
  readonly threadId?: string | null;
  readonly runId?: string | null;
}

/** Inserts a rule as the app role, inside the team (RLS applies). */
function insert(row: Row) {
  const scope = row.scope ?? "user";
  return withTeam(app.db, teamId, (tx) =>
    tx.execute<{ id: string }>(sql`
      INSERT INTO tool_rules (team_id, scope, user_id, effect, tool_glob, created_by,
                              remember_scope, thread_id, run_id)
      VALUES (${teamId}, ${scope}, ${scope === "user" ? userId : null}, 'allow', 'bash', ${userId},
              ${row.rememberScope ?? null}, ${row.threadId ?? null}, ${row.runId ?? null})
      RETURNING id`),
  );
}

async function rejects(row: Row): Promise<string | undefined> {
  try {
    await insert(row);
    return undefined;
  } catch (err) {
    const e = err as { cause?: { constraint?: string }; constraint?: string };
    return e.cause?.constraint ?? e.constraint ?? "error";
  }
}

describe("tool_rules remember scopes (KOBE-289)", () => {
  it("stores every scope with its binding", async () => {
    for (const rememberScope of ["today", "day", "month", "forever"]) {
      await expect(insert({ rememberScope })).resolves.toBeDefined();
    }
    await expect(insert({ rememberScope: "thread", threadId })).resolves.toBeDefined();
    await expect(insert({ rememberScope: "run", runId })).resolves.toBeDefined();
    await expect(insert({ scope: "team" })).resolves.toBeDefined();
  });

  it("refuses rules without their scope or with the wrong binding", async () => {
    expect(await rejects({})).toBe("tool_rules_remember_scope");
    expect(await rejects({ rememberScope: "week" })).toBe("tool_rules_remember_scope");
    expect(await rejects({ scope: "team", rememberScope: "day" })).toBe(
      "tool_rules_remember_scope",
    );
    expect(await rejects({ rememberScope: "thread" })).toBe("tool_rules_remember_binding");
    expect(await rejects({ rememberScope: "run" })).toBe("tool_rules_remember_binding");
    expect(await rejects({ rememberScope: "day", threadId })).toBe("tool_rules_remember_binding");
    expect(await rejects({ rememberScope: "thread", threadId, runId })).toBe(
      "tool_rules_remember_binding",
    );
    expect(await rejects({ rememberScope: "run", runId: randomUUID() })).toBe("tool_rules_run_fk");
  });

  it("a thread or run rule goes with its thread or run", async () => {
    const own = await threadAndRun();
    const t = await insert({ rememberScope: "thread", threadId: own.threadId });
    const r = await insert({ rememberScope: "run", runId: own.runId });
    const ids = [t.rows[0]?.id, r.rows[0]?.id];
    const count = async () =>
      (await admin.query(`SELECT 1 FROM tool_rules WHERE id = ANY($1)`, [ids])).rowCount;
    expect(await count()).toBe(2);
    await admin.query(`DELETE FROM runs WHERE team_id = $1 AND id = $2`, [teamId, own.runId]);
    expect(await count()).toBe(1);
    await admin.query(`DELETE FROM threads WHERE team_id = $1 AND id = $2`, [teamId, own.threadId]);
    expect(await count()).toBe(0);
  });

  it("bounds the stored time zone", async () => {
    await expect(
      admin.query(`UPDATE users SET time_zone = $2 WHERE id = $1`, [userId, "x".repeat(65)]),
    ).rejects.toThrow(/users_time_zone/);
    await admin.query(`UPDATE users SET time_zone = 'Europe/Berlin' WHERE id = $1`, [userId]);
  });

  it("backfills KOBE-37's rules by their expiry", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query(`ALTER TABLE tool_rules DROP CONSTRAINT tool_rules_remember_scope`);
      await admin.query(`ALTER TABLE tool_rules DROP CONSTRAINT tool_rules_remember_binding`);
      const seeded = await admin.query<{ id: string; expect: string }>(
        `INSERT INTO tool_rules (team_id, scope, user_id, effect, tool_glob, created_by, created_at, expires_at)
         VALUES ($1, 'user', $2, 'allow', 'read', $2, now(), NULL),
                ($1, 'user', $2, 'allow', 'read', $2, now(), now() + interval '1 day'),
                ($1, 'user', $2, 'allow', 'read', $2, now(), now() + interval '30 days')
         RETURNING id, CASE WHEN expires_at IS NULL THEN 'forever'
                            WHEN expires_at < now() + interval '2 days' THEN 'day'
                            ELSE 'month' END AS expect`,
        [teamId, userId],
      );
      await admin.query(migrationSql);
      const after = await admin.query<{ id: string; remember_scope: string }>(
        `SELECT id, remember_scope FROM tool_rules WHERE id = ANY($1)`,
        [seeded.rows.map((r) => r.id)],
      );
      const got = Object.fromEntries(after.rows.map((r) => [r.id, r.remember_scope]));
      for (const row of seeded.rows) expect(got[row.id]).toBe(row.expect);
      expect(new Set(Object.values(got))).toEqual(new Set(["forever", "day", "month"]));
    } finally {
      await admin.query("ROLLBACK");
    }
  });
});
