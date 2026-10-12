import { randomBytes, randomUUID } from "node:crypto";
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
 * KOBE-256 (R3): "Site" replaced "Install" in the database. A site migrated up to the release
 * before the rename, with rows in every renamed table, upgrades in place: every install_* object
 * is renamed (metadata only: same relation, same data files), the stored scope values of the
 * small site tables move to the new names, and the database's own functions work on the new names.
 * It names the old tables on purpose (site-identifiers: allow-file).
 */

const RENAMED_TABLES = {
  install_settings: "site_settings",
  install_roles: "site_roles",
  install_model_limits: "site_model_limits",
  install_model_spend_daily: "site_model_spend_daily",
  install_budget_reservations: "site_budget_reservations",
  install_tool_rules: "site_tool_rules",
  install_agents: "site_agents",
  install_agent_versions: "site_agent_versions",
  install_skills: "site_skills",
  install_skill_versions: "site_skill_versions",
  install_skill_scans: "site_skill_scans",
} as const;

/** The first statement of the rename migration: the release before it has the old names. */
const RENAME_MARKER = 'ALTER TABLE "install_settings" RENAME TO "site_settings"';

let db: TestDatabase | undefined;
let oldMigrations = "";
const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};
const suffix = randomBytes(4).toString("hex");

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const ids = {
  owner: randomUUID(),
  admin: randomUUID(),
  member: randomUUID(),
  team: randomUUID(),
  rule: randomUUID(),
  personalAgent: randomUUID(),
  galleryAgent: randomUUID(),
  skill: randomUUID(),
  thread: randomUUID(),
  run: randomUUID(),
  grant: randomUUID(),
};

/** Rows in every renamed table, as the pre-rename release wrote them (guard triggers skipped). */
async function seedPreRename(c: pg.Client): Promise<void> {
  await c.query("BEGIN");
  await c.query("SET LOCAL session_replication_role = replica");
  const q = (text: string, values: unknown[] = []) => c.query(text, values);
  for (const [id, name] of [
    [ids.owner, "Owner"],
    [ids.admin, "Admin"],
    [ids.member, "Member"],
  ] as const) {
    await q(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
      id,
      name,
      `${name.toLowerCase()}-${suffix}@example.test`,
    ]);
  }
  await q(`INSERT INTO install_roles (user_id, role) VALUES ($1, 'owner'), ($2, 'admin')`, [
    ids.owner,
    ids.admin,
  ]);
  await q(`INSERT INTO install_settings (key, value) VALUES ('audit.pii_retention_hours', '24')`);
  await q(`UPDATE install_model_limits SET monthly_usd = 100 WHERE id = 1`);
  await q(
    `INSERT INTO install_model_spend_daily (day, cost_usd, tokens) VALUES ('2026-01-01', 1.5, 1000)`,
  );
  await q(
    `INSERT INTO install_budget_reservations (team_key, call_id, member_key, usd, tokens, expires_at)
     VALUES ('team-key', 'call-1', 'member-key', 0.5, 10, now() + interval '1 hour')`,
  );
  await q(
    `INSERT INTO install_tool_rules (id, effect, tool_glob, created_by) VALUES ($1, 'deny', 'shell.*', $2)`,
    [ids.rule, ids.admin],
  );
  await q(
    `INSERT INTO install_agents (id, scope, owner_user_id, slug, frontmatter, current_version)
     VALUES ($1, 'personal', $2, 'helper', '{}', 1), ($3, 'gallery', NULL, 'writer', '{}', 1)`,
    [ids.personalAgent, ids.member, ids.galleryAgent],
  );
  await q(
    `INSERT INTO install_agent_versions (agent_id, version, frontmatter, prompt, tool_manifest, draft_revision)
     VALUES ($1, 1, '{}', 'Help.', '{}', 1), ($2, 1, '{}', 'Write.', '{}', 1)`,
    [ids.personalAgent, ids.galleryAgent],
  );
  await q(
    `INSERT INTO install_skills (id, owner_user_id, slug, description, latest_version)
     VALUES ($1, $2, 'pdf', 'PDF tools', 1)`,
    [ids.skill, ids.member],
  );
  await q(
    `INSERT INTO install_skill_versions (skill_id, version, frontmatter, source, content_hash,
       storage_key, size_bytes, file_count, uncompressed_bytes, uploaded_by)
     VALUES ($1, 1, '{}', 'zip', repeat('a', 64), 'skills/pdf/1.zip', 10, 1, 10, $2)`,
    [ids.skill, ids.member],
  );
  await q(
    `INSERT INTO install_skill_scans (skill_id, version, flagged, findings, scripts, skipped)
     VALUES ($1, 1, false, '[]', '[]', '[]')`,
    [ids.skill],
  );
  await q(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Rename')`, [
    ids.team,
    `rename-${suffix}`,
  ]);
  await q(
    `INSERT INTO threads (team_id, id, owner_user_id, agent_scope, agent_id, agent_version)
     VALUES ($1, $2, $3, 'personal', $4, 1)`,
    [ids.team, ids.thread, ids.member, ids.personalAgent],
  );
  await q(
    `INSERT INTO runs (team_id, id, thread_id, trigger, budget_stop_scope)
     VALUES ($1, $2, $3, 'user', 'install')`,
    [ids.team, ids.run, ids.thread],
  );
  await q(
    `INSERT INTO budget_alerts (scope, period, period_start, threshold, unit, limit_amount, spent_amount)
     VALUES ('install', 'month', date_trunc('month', now())::date, 80, 'usd', 100, 85)`,
  );
  await q(
    `INSERT INTO break_glass_grants (id, team_id, admin_id, reason) VALUES ($1, $2, $3, 'Incident')`,
    [ids.grant, ids.team, ids.admin],
  );
  await q(
    `INSERT INTO break_glass_notifications (grant_id, event, recipient_id, recipient_role)
     VALUES ($1, 'requested', $2, 'install_admin')`,
    [ids.grant, ids.owner],
  );
  await c.query("COMMIT");
}

interface Relation {
  readonly name: string;
  readonly oid: number;
  readonly filenode: number;
  readonly rows: number;
}

async function relations(c: pg.Client, names: readonly string[]): Promise<Relation[]> {
  const out: Relation[] = [];
  for (const name of names) {
    const res = await c.query<{ oid: number; filenode: number }>(
      `SELECT oid::int, relfilenode::int AS filenode FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = $1`,
      [name],
    );
    const count = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${name}"`);
    const rel = res.rows[0];
    if (!rel) throw new Error(`no relation ${name}`);
    out.push({ name, oid: rel.oid, filenode: rel.filenode, rows: count.rows[0]?.n ?? -1 });
  }
  return out;
}

/** Every object in `public` whose name or definition still says "install". */
const LEFTOVER_OBJECTS = `
  SELECT 'relation ' || c.relname AS hit FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname ILIKE '%install%'
  UNION ALL
  SELECT 'type ' || t.typname FROM pg_type t
   WHERE t.typnamespace = 'public'::regnamespace AND t.typname ILIKE '%install%'
  UNION ALL
  SELECT 'enum value ' || t.typname || '.' || e.enumlabel FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typnamespace = 'public'::regnamespace AND e.enumlabel ILIKE '%install%'
  UNION ALL
  SELECT 'column ' || c.relname || '.' || a.attname FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v')
     AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ILIKE '%install%'
  UNION ALL
  SELECT 'constraint ' || c.relname || '.' || con.conname FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
   WHERE c.relnamespace = 'public'::regnamespace
     AND (con.conname ILIKE '%install%' OR pg_get_constraintdef(con.oid) ILIKE '%install%')
  UNION ALL
  SELECT 'trigger ' || c.relname || '.' || tg.tgname FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE c.relnamespace = 'public'::regnamespace AND NOT tg.tgisinternal
     AND tg.tgname ILIKE '%install%'
  UNION ALL
  SELECT 'function ' || p.proname FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND (p.proname ILIKE '%install%' OR p.prosrc ILIKE '%install%')
  UNION ALL
  SELECT 'policy ' || tablename || '.' || policyname FROM pg_policies
   WHERE schemaname = 'public'
     AND (policyname ILIKE '%install%' OR qual ILIKE '%install%' OR with_check ILIKE '%install%')
  UNION ALL
  SELECT 'index ' || indexname FROM pg_indexes
   WHERE schemaname = 'public' AND indexdef ILIKE '%install%'
  ORDER BY 1`;

/**
 * Run rows are history (the stop scope a run ended with): the check still admits the old value.
 * kobe_reserve_budget takes an `install` line (a gateway of the release before) as the site's.
 */
const KEPT = ["constraint runs.runs_budget_stop_scope", "function kobe_reserve_budget"];

let before: Relation[] = [];
let after: Relation[] = [];

beforeAll(async () => {
  oldMigrations = migrationsBefore(RENAME_MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: oldMigrations });
  const { adminUrl, ownerUrl, appRole } = db;
  await withClient(adminUrl, async (c) => {
    await seedPreRename(c);
    before = await relations(c, [...Object.keys(RENAMED_TABLES), "threads"]);
  });
  await runMigrations({ databaseUrl: ownerUrl, appRole });
  after = await withClient(adminUrl, (c) =>
    relations(c, [...Object.values(RENAMED_TABLES), "threads"]),
  );
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("site rename migration on an existing database (KOBE-256)", () => {
  it("renames every install_* object; only the run history check and the reserve function keep the old value", async () => {
    const hits = await withClient(database().adminUrl, (c) =>
      c.query<{ hit: string }>(LEFTOVER_OBJECTS).then((r) => r.rows.map((row) => row.hit)),
    );
    expect(hits).toEqual(KEPT);
  });

  it("renames in place: same relations, same data files, same row counts", () => {
    expect(after.map((r) => [r.oid, r.filenode, r.rows])).toEqual(
      before.map((r) => [r.oid, r.filenode, r.rows]),
    );
    expect(after.every((r) => r.rows > 0)).toBe(true);
  });

  it("keeps the rows: roles, settings, limits, rules, agents, skills, the thread's agent pin", async () => {
    await withClient(database().adminUrl, async (c) => {
      const one = async (text: string, values: unknown[] = []) =>
        (await c.query(text, values)).rows[0] as Record<string, unknown>;
      expect(
        await one(`SELECT role::text FROM site_roles WHERE user_id = $1`, [ids.admin]),
      ).toEqual({ role: "admin" });
      expect(
        await one(`SELECT pg_typeof(role)::text AS t FROM site_roles WHERE user_id = $1`, [
          ids.owner,
        ]),
      ).toEqual({ t: "site_role" });
      expect(await one(`SELECT monthly_usd FROM site_model_limits WHERE id = 1`)).toEqual({
        monthly_usd: "100.00",
      });
      expect(await one(`SELECT tool_glob FROM site_tool_rules WHERE id = $1`, [ids.rule])).toEqual({
        tool_glob: "shell.*",
      });
      expect(
        await one(
          `SELECT scope::text, pg_typeof(scope)::text AS t FROM site_agents WHERE id = $1`,
          [ids.galleryAgent],
        ),
      ).toEqual({ scope: "gallery", t: "site_agent_scope" });
      expect(
        await one(`SELECT prompt FROM site_agent_versions WHERE agent_id = $1`, [
          ids.personalAgent,
        ]),
      ).toEqual({ prompt: "Help." });
      expect(
        await one(`SELECT storage_key FROM site_skill_versions WHERE skill_id = $1`, [ids.skill]),
      ).toEqual({ storage_key: "skills/pdf/1.zip" });
      expect(await one(`SELECT site_agent_id FROM threads WHERE id = $1`, [ids.thread])).toEqual({
        site_agent_id: ids.personalAgent,
      });
    });
  });

  it("moves the stored site scope of budget alerts and break-glass recipients to the new names", async () => {
    await withClient(database().adminUrl, async (c) => {
      const alerts = await c.query(`SELECT scope FROM budget_alerts`);
      expect(alerts.rows).toEqual([{ scope: "site" }]);
      const recipients = await c.query(`SELECT recipient_role FROM break_glass_notifications`);
      expect(recipients.rows).toEqual([{ recipient_role: "site_admin" }]);
      await expect(
        c.query(
          `INSERT INTO break_glass_notifications (grant_id, event, recipient_id, recipient_role)
           VALUES ($1, 'approved', $2, 'install_admin')`,
          [ids.grant, ids.owner],
        ),
      ).rejects.toThrow(/break_glass_notifications_role/);
    });
  });

  it("keeps a run's historical stop scope and accepts the new one", async () => {
    await withClient(database().adminUrl, async (c) => {
      const run = await c.query(`SELECT budget_stop_scope FROM runs WHERE id = $1`, [ids.run]);
      expect(run.rows).toEqual([{ budget_stop_scope: "install" }]);
      await c.query(`UPDATE runs SET budget_stop_scope = 'site' WHERE id = $1`, [ids.run]);
      await expect(
        c.query(`UPDATE runs SET budget_stop_scope = 'everyone' WHERE id = $1`, [ids.run]),
      ).rejects.toThrow(/runs_budget_stop_scope/);
    });
  });

  it("points the database's own functions at the renamed tables (as the app role)", async () => {
    await withClient(database().appUrl, async (c) => {
      const hours = await c.query(`SELECT audit_pii_retention_hours() AS h`);
      expect(Number(hours.rows[0]?.h)).toBe(24);
      const admin = await c.query(`SELECT break_glass_is_site_admin($1) AS yes`, [ids.admin]);
      expect(admin.rows[0]?.yes).toBe(true);
      const member = await c.query(`SELECT break_glass_is_site_admin($1) AS yes`, [ids.member]);
      expect(member.rows[0]?.yes).toBe(false);
    });
    await withClient(database().adminUrl, async (c) => {
      // run_usage's spend trigger counts into the site's daily total.
      await c.query(
        `INSERT INTO run_usage (team_id, user_id, sandbox_id, route, model, status, usage_source,
                                cost_usd, duration_ms, input_tokens)
         VALUES ($1, $2, $3, 'openai', 'm', 200, 'reported', 0.25, 10, 100)`,
        [ids.team, ids.member, randomUUID()],
      );
      const today = await c.query(
        `SELECT cost_usd::text FROM site_model_spend_daily
          WHERE day = (now() AT TIME ZONE 'UTC')::date`,
      );
      expect(today.rows).toEqual([{ cost_usd: "0.2500000000" }]);
    });
  });

  it("gives the app role the grants matrix on the renamed tables", async () => {
    await withClient(database().adminUrl, async (c) => {
      const res = await c.query<{ t: string; p: string }>(
        `SELECT table_name AS t, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
           FROM information_schema.role_table_grants
          WHERE grantee = $1 AND table_name IN ('site_roles', 'site_settings', 'site_agent_versions')
          GROUP BY 1 ORDER BY 1`,
        [database().appRole],
      );
      expect(res.rows).toEqual([
        { t: "site_agent_versions", p: "INSERT,SELECT" },
        { t: "site_roles", p: "DELETE,INSERT,SELECT,UPDATE" },
        { t: "site_settings", p: "INSERT,SELECT,UPDATE" },
      ]);
    });
  });
});
