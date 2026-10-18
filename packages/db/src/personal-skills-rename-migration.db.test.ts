import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "./audit/index.js";
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";
import {
  createTestDatabase,
  migrationsBefore,
  testServerUrl,
  type TestDatabase,
} from "./test-support/database.js";

/**
 * KOBE-307 (Skills v1.2, SK3): personal skills are no longer called "site" skills. A site migrated
 * up to the release before the rename, with a personal skill, its version and scan, and audit rows
 * about them, upgrades in place as the non-superuser owner: every site_skill* object is renamed
 * (metadata only), the app role keeps exactly its grants, the immutability trigger still guards
 * the versions, and no audit row is touched (the hash chain verifies). It names the old tables on
 * purpose (site-identifiers: allow-file).
 */

const RENAMED_TABLES = {
  site_skills: "personal_skills",
  site_skill_versions: "personal_skill_versions",
  site_skill_scans: "personal_skill_scans",
} as const;

/** The first statement of the rename migration: the release before it has the old names. */
const RENAME_MARKER = 'ALTER TABLE "site_skills" RENAME TO "personal_skills"';

/** Constraints and triggers of the renamed tables after the upgrade. */
const EXPECTED_CONSTRAINTS = [
  "personal_skill_scans.personal_skill_scans_skill_id_version_pk",
  "personal_skill_scans.personal_skill_scans_version_fk",
  "personal_skill_versions.personal_skill_versions_content_hash_format",
  "personal_skill_versions.personal_skill_versions_frontmatter_object",
  "personal_skill_versions.personal_skill_versions_sizes",
  "personal_skill_versions.personal_skill_versions_skill_fk",
  "personal_skill_versions.personal_skill_versions_skill_id_version_pk",
  "personal_skill_versions.personal_skill_versions_uploaded_by_users_id_fk",
  "personal_skill_versions.personal_skill_versions_version_positive",
  "personal_skills.personal_skills_description_size",
  "personal_skills.personal_skills_latest_version_positive",
  "personal_skills.personal_skills_owner_user_id_users_id_fk",
  "personal_skills.personal_skills_pkey",
  "personal_skills.personal_skills_slug_format",
  "personal_skills.personal_skills_slug_unique",
];

/** Every object in `public` whose name or definition still says "site_skill". */
const LEFTOVER_OBJECTS = `
  SELECT 'relation ' || c.relname AS hit FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname ILIKE '%site\\_skill%'
  UNION ALL
  SELECT 'type ' || t.typname FROM pg_type t
   WHERE t.typnamespace = 'public'::regnamespace AND t.typname ILIKE '%site\\_skill%'
  UNION ALL
  SELECT 'constraint ' || c.relname || '.' || con.conname FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
   WHERE c.relnamespace = 'public'::regnamespace
     AND (con.conname ILIKE '%site\\_skill%' OR pg_get_constraintdef(con.oid) ILIKE '%site\\_skill%')
  UNION ALL
  SELECT 'trigger ' || c.relname || '.' || tg.tgname FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE c.relnamespace = 'public'::regnamespace AND NOT tg.tgisinternal
     AND tg.tgname ILIKE '%site\\_skill%'
  UNION ALL
  SELECT 'function ' || p.proname FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND (p.proname ILIKE '%site\\_skill%' OR p.prosrc ILIKE '%site\\_skill%')
  UNION ALL
  SELECT 'policy ' || tablename || '.' || policyname FROM pg_policies
   WHERE schemaname = 'public'
     AND (policyname ILIKE '%site\\_skill%' OR qual ILIKE '%site\\_skill%'
          OR with_check ILIKE '%site\\_skill%')
  UNION ALL
  SELECT 'index ' || indexname FROM pg_indexes
   WHERE schemaname = 'public' AND indexdef ILIKE '%site\\_skill%'
  UNION ALL
  SELECT 'view ' || c.relname FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
     AND pg_get_viewdef(c.oid) ILIKE '%site\\_skill%'
  UNION ALL
  SELECT 'default ' || c.relname || '.' || a.attname FROM pg_attrdef d
    JOIN pg_class c ON c.oid = d.adrelid
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
   WHERE c.relnamespace = 'public'::regnamespace
     AND pg_get_expr(d.adbin, d.adrelid) ILIKE '%site\\_skill%'
  UNION ALL
  SELECT 'comment ' || d.objoid::text FROM pg_description d
   WHERE d.description ILIKE '%site\\_skill%'
  ORDER BY 1`;

let db: TestDatabase | undefined;
let oldMigrations = "";
const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};
const suffix = randomBytes(4).toString("hex");
const ids = { member: randomUUID(), skill: randomUUID() };
const HASH = "b".repeat(64);

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/**
 * A personal skill as the release before the rename wrote it. Seeded as the superuser: the app
 * role's grants follow this release's matrix, which names the new tables. Triggers run (no replica
 * mode), so the database hashes the audit rows into the chain.
 */
async function seedPreRename(admin: pg.Client): Promise<void> {
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, 'Member', $2)`, [
    ids.member,
    `member-${suffix}@example.test`,
  ]);
  await admin.query(
    `INSERT INTO site_skills (id, owner_user_id, slug, description, latest_version)
     VALUES ($1, $2, 'pdf', 'PDF tools', 1)`,
    [ids.skill, ids.member],
  );
  await admin.query(
    `INSERT INTO site_skill_versions (skill_id, version, frontmatter, source, content_hash,
       storage_key, size_bytes, file_count, uncompressed_bytes, uploaded_by)
     VALUES ($1, 1, '{}', 'zip', $2, 'skills/pdf/1.zip', 10, 1, 10, $3)`,
    [ids.skill, HASH, ids.member],
  );
  await admin.query(
    `INSERT INTO site_skill_scans (skill_id, version, flagged, findings, scripts, skipped)
     VALUES ($1, 1, false, '[]', '[]', '[]')`,
    [ids.skill],
  );
  const target = { skillId: ids.skill, scope: "personal", slug: "pdf", version: 1 };
  for (const action of ["skill.uploaded", "skill.personal_switch.changed"]) {
    await admin.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, target) VALUES ('user', $1, $2, $3)`,
      [ids.member, action, JSON.stringify(target)],
    );
  }
}

interface Relation {
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
    out.push({ oid: rel.oid, filenode: rel.filenode, rows: count.rows[0]?.n ?? -1 });
  }
  return out;
}

const AUDIT_ROWS = `SELECT seq::text, action, hash FROM audit_log ORDER BY seq`;

let before: Relation[] = [];
let after: Relation[] = [];
let auditBefore: unknown[] = [];

beforeAll(async () => {
  oldMigrations = migrationsBefore(RENAME_MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: oldMigrations });
  const { adminUrl, ownerUrl, appRole } = db;
  await withClient(adminUrl, async (c) => {
    await seedPreRename(c);
    before = await relations(c, Object.keys(RENAMED_TABLES));
    auditBefore = (await c.query(AUDIT_ROWS)).rows;
  });
  // As production's migration Job: the non-superuser owner, not the test superuser.
  await runMigrations({ databaseUrl: ownerUrl, appRole });
  after = await withClient(adminUrl, (c) => relations(c, Object.values(RENAMED_TABLES)));
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("personal skills rename migration on an existing database (KOBE-307)", () => {
  it("leaves no object named after site skills", async () => {
    const hits = await withClient(database().adminUrl, (c) =>
      c.query<{ hit: string }>(LEFTOVER_OBJECTS).then((r) => r.rows.map((row) => row.hit)),
    );
    expect(hits).toEqual([]);
  });

  it("renames in place: same relations, same data files, the rows kept", () => {
    expect(after).toEqual(before);
    expect(after.every((r) => r.rows === 1)).toBe(true);
  });

  it("renames every constraint and the immutability trigger", async () => {
    await withClient(database().adminUrl, async (c) => {
      const cons = await c.query<{ name: string }>(
        `SELECT c.relname || '.' || con.conname AS name FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
          WHERE c.relname = ANY($1) ORDER BY 1`,
        [Object.values(RENAMED_TABLES)],
      );
      // The test migrates to the end: later migrations (KOBE-308) add constraints of their own.
      expect(cons.rows.map((r) => r.name)).toEqual(expect.arrayContaining(EXPECTED_CONSTRAINTS));
      const triggers = await c.query<{ name: string }>(
        `SELECT c.relname || '.' || tg.tgname AS name FROM pg_trigger tg
           JOIN pg_class c ON c.oid = tg.tgrelid
          WHERE c.relname = ANY($1) AND NOT tg.tgisinternal ORDER BY 1`,
        [Object.values(RENAMED_TABLES)],
      );
      expect(triggers.rows.map((r) => r.name)).toEqual([
        "personal_skill_versions.personal_skill_versions_immutable",
      ]);
    });
  });

  it("keeps the app role's grants: skills read-write, versions and scans append-only", async () => {
    const { adminUrl, appRole } = database();
    await withClient(adminUrl, async (c) => {
      const privileges = async (table: string) => {
        const res = await c.query<{ p: string }>(
          `SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
            WHERE has_table_privilege($1, $2, p) ORDER BY 1`,
          [appRole, table],
        );
        return res.rows.map((r) => r.p);
      };
      expect(await privileges("personal_skills")).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
      expect(await privileges("personal_skill_versions")).toEqual(["INSERT", "SELECT"]);
      expect(await privileges("personal_skill_scans")).toEqual(["INSERT", "SELECT"]);
    });
  });

  it("serves the app role under the new names; versions stay immutable", async () => {
    const { appUrl, ownerUrl } = database();
    await withClient(appUrl, async (c) => {
      const row = await c.query(
        `SELECT s.slug, v.storage_key, sc.flagged FROM personal_skills s
           JOIN personal_skill_versions v ON v.skill_id = s.id
           JOIN personal_skill_scans sc ON sc.skill_id = v.skill_id AND sc.version = v.version
          WHERE s.id = $1`,
        [ids.skill],
      );
      expect(row.rows).toEqual([{ slug: "pdf", storage_key: "skills/pdf/1.zip", flagged: false }]);
      await expect(
        c.query(`UPDATE personal_skill_versions SET storage_key = 'x' WHERE skill_id = $1`, [
          ids.skill,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    });
    await withClient(ownerUrl, async (c) => {
      await expect(
        c.query(`UPDATE personal_skill_versions SET storage_key = 'x' WHERE skill_id = $1`, [
          ids.skill,
        ]),
      ).rejects.toMatchObject({ code: "55000" });
    });
  });

  it("touches no audit row: same rows, same hashes, the chain verifies", async () => {
    const { adminUrl, appUrl } = database();
    const rows = await withClient(adminUrl, async (c) => (await c.query(AUDIT_ROWS)).rows);
    expect(rows).toEqual(auditBefore);
    expect(rows.map((r) => (r as { action: string }).action)).toEqual(
      expect.arrayContaining(["skill.uploaded", "skill.personal_switch.changed"]),
    );
    const app = createDb(appUrl);
    try {
      const report = await verifyAuditChain(app.db);
      expect(report.ok).toBe(true);
    } finally {
      await app.close();
    }
  });
});
