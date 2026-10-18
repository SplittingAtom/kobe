import { MIGRATION_LOCK_KEY, STARTUP_SEEDED_ROWS } from "@kobe/db";
import { testServerUrl, type TestDatabase } from "@kobe/db/testing";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { listImmediateForeignKeys, listTables, listUserTriggers, readJournal } from "./catalog.js";
import { restorePrelude, type RestorePlan } from "./restore-sql.js";
import { freshTarget, serverStarted, sql } from "./testing/fixtures.js";

/**
 * The restore's target checks (KOBE-422) on a real Postgres, without pg_dump: the prelude the
 * restore sends first runs against a fresh target, then rolls back. A site whose server started
 * holds only startup-seeded rows (`@kobe/db` STARTUP_SEEDED_ROWS): accepted, and those rows are
 * gone before the backup's load. Any other row is real data: refused.
 */
const server = testServerUrl();
const created: TestDatabase[] = [];

afterAll(async () => {
  for (const db of created) await db.drop();
});

async function started(): Promise<TestDatabase> {
  const db = await freshTarget(server);
  created.push(db);
  await serverStarted(db.adminUrl);
  return db;
}

/** Runs the prelude as the owner; returns the startup-seeded tables' row counts inside it. */
async function prelude(db: TestDatabase): Promise<Record<string, number | string>> {
  const client = new pg.Client({ connectionString: db.ownerUrl });
  await client.connect();
  try {
    const tables = await listTables(client);
    const plan: RestorePlan = {
      lockKey: MIGRATION_LOCK_KEY,
      migrations: await readJournal(client),
      lockTables: tables.map((t) => t.name),
      loadTables: tables.filter((t) => t.name !== "jwks").map((t) => ({ name: t.name, rows: 0 })),
      forcedRls: tables.filter((t) => t.forcedRls).map((t) => t.name),
      userTriggers: await listUserTriggers(client),
      immediateForeignKeys: await listImmediateForeignKeys(client),
    };
    await client.query(restorePrelude(plan));
    const counts: Record<string, number | string> = {};
    const replaced = await client.query<{ v: string | null }>(
      "SELECT current_setting('kobe.restore.replaced_audit', true) AS v",
    );
    counts.replacedAudit = replaced.rows[0]?.v ?? "";
    for (const name of Object.keys(STARTUP_SEEDED_ROWS)) {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public."${name}"`,
      );
      counts[name] = rows[0]?.n ?? -1;
    }
    return counts;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

describe("kobe restore's target check on a started site (KOBE-422)", () => {
  it("accepts the rows the server's start wrote and replaces them before the load", async () => {
    const db = await started();
    const [head] = await sql<{ hash: string }>(
      db.adminUrl,
      "SELECT hash FROM audit_log WHERE seq = 2",
    );
    expect(await prelude(db)).toEqual({
      site_agents: 0,
      site_agent_versions: 0,
      audit_log: 0,
      site_settings: 0,
      // Kobe's catalog skills and the jobs they start (KOBE-317): none in this fixture.
      registry_skills: 0,
      registry_versions: 0,
      registry_skill_tags: 0,
      skill_default_syncs: 0,
      team_skill_installs: 0,
      skill_rescan_runs: 0,
      // The replaced chain's head and size, for the restore's event (KOBE-422).
      replacedAudit: `2:${head?.hash ?? ""}:2`,
    });
    // Rolled back: the started site is as it was.
    expect(await sql(db.adminUrl, "SELECT slug FROM site_agents")).toEqual([{ slug: "kobe" }]);
    expect(await sql(db.adminUrl, "SELECT count(*)::int AS n FROM audit_log")).toEqual([{ n: 2 }]);
  });

  it.each([
    ["users", "INSERT INTO users (name, email) VALUES ('Ann', 'ann@example.com')"],
    [
      "site_agents",
      `INSERT INTO users (id, name, email) VALUES ('00000000-0000-4000-8000-0000000000a1', 'Ann', 'a@example.com');
       INSERT INTO site_agents (scope, owner_user_id, slug, frontmatter)
         VALUES ('personal', '00000000-0000-4000-8000-0000000000a1', 'mine', '{"name":"Mine"}')`,
    ],
    [
      "audit_log",
      `INSERT INTO audit_log (actor_kind, action, target)
         VALUES ('system', 'platform.isolation.changed', '{"from":"verified","to":"missing"}')`,
    ],
    ["site_settings", "INSERT INTO site_settings (key, value) VALUES ('require_2fa', 'true')"],
    [
      // The Default sync's system event for a skill that is not Kobe's (a site admin's job).
      "audit_log",
      `INSERT INTO audit_log (actor_kind, action, target)
         VALUES ('system', 'skill.default.synced', '{"skillId":"00000000-0000-4000-8000-0000000000b1"}')`,
    ],
  ])("still refuses a started site with real data in %s", async (table, insert) => {
    const db = await started();
    await sql(db.adminUrl, insert);
    await expect(prelude(db)).rejects.toThrow(
      new RegExp(`already has data in:.*\\b${table}\\b.*restore only into a freshly installed`),
    );
  });
});
