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
 * KOBE-495 (0180, 0181): a Site with catalog rows migrates as the non-superuser owner, in one
 * transaction with the new publisher value `site` (never used before commit); then a Site admin's
 * version is published on a Kobe and a maintainer skill, the publisher rule still holds for every
 * other version, Kobe skills carry a detached marker, site drafts hold files, and a maintainer's
 * notification names its Site admin.
 */
const MARKER = `ADD VALUE 'site'`;

let db: TestDatabase | undefined;
let oldMigrations = "";
const suffix = randomBytes(4).toString("hex");
const ids = {
  admin: randomUUID(),
  maintainer: randomUUID(),
  team: randomUUID(),
  skill: randomUUID(),
  version: randomUUID(),
  kobe: randomUUID(),
  kobeVersion: randomUUID(),
};
const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const COLUMNS = `skill_id, publisher, semver, seq, runtime_hash, package_hash, runtime_storage_key,
  runtime_size_bytes, manifest, provenance, source, scan, verdict, state, approved_at,
  submitted_by, reviewed_by`;

/** A published version; `submitter`/`reviewer` null where the publisher has none. */
function version(
  c: pg.Client,
  v: {
    skill: string;
    publisher: string;
    semver: string;
    seq: number;
    submitter: string | null;
    reviewer?: string | null;
  },
) {
  return c.query<{ id: string }>(
    `INSERT INTO registry_versions (${COLUMNS})
     VALUES ($1, $2::registry_publisher, $3, $4, repeat('a', 64), repeat('b', 64), 'k', 10, '{}',
       '{}', '{}', '{}', 'pass', 'approved', now(), $5, $6) RETURNING id`,
    [v.skill, v.publisher, v.semver, v.seq, v.submitter, v.reviewer ?? null],
  );
}

beforeAll(async () => {
  oldMigrations = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: oldMigrations });
  await withClient(db.adminUrl, async (c) => {
    for (const [id, name] of [
      [ids.admin, "Admin"],
      [ids.maintainer, "Maintainer"],
    ] as const)
      await c.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
        id,
        name,
        `${name.toLowerCase()}-${suffix}@example.test`,
      ]);
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Makers')`, [
      ids.team,
      `makers-${suffix}`,
    ]);
    await c.query(`INSERT INTO registry_skills (id, name, summary) VALUES ($1, $2, 'Q.')`, [
      ids.skill,
      `report-${suffix}`,
    ]);
    await c.query(
      `INSERT INTO registry_skills (id, name, summary, publisher) VALUES ($1, 'docx', 'D.', 'kobe')`,
      [ids.kobe],
    );
    await c.query(
      `INSERT INTO registry_versions (id, ${COLUMNS})
       VALUES ($1, $2, 'maintainer', '1.0.0', 1, repeat('a', 64), repeat('b', 64), 'k', 10, '{}',
         '{}', '{}', '{}', 'pass', 'approved', now(), $3, $4)`,
      [ids.version, ids.skill, ids.maintainer, ids.admin],
    );
    await c.query(
      `INSERT INTO registry_versions (id, ${COLUMNS})
       VALUES ($1, $2, 'kobe', '1.0.0', 1, repeat('c', 64), repeat('d', 64), 'k', 10, '{}', '{}',
         '{}', '{}', 'pass', 'approved', now(), NULL, NULL)`,
      [ids.kobeVersion, ids.kobe],
    );
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("site-published catalog versions (0180, 0181)", () => {
  it("publishes a Site admin's version on a maintainer's and on a Kobe skill", async () => {
    await withClient(database().appUrl, async (c) => {
      const a = await version(c, {
        skill: ids.skill,
        publisher: "site",
        semver: "1.1.0",
        seq: 2,
        submitter: ids.admin,
      });
      const b = await version(c, {
        skill: ids.kobe,
        publisher: "site",
        semver: "1.0.1",
        seq: 2,
        submitter: ids.admin,
      });
      expect(a.rows[0]?.id).toBeTruthy();
      expect(b.rows[0]?.id).toBeTruthy();
    });
  });

  it("refuses a site version with a reviewer or without its admin", async () => {
    await withClient(database().appUrl, async (c) => {
      await expect(
        version(c, {
          skill: ids.skill,
          publisher: "site",
          semver: "1.2.0",
          seq: 3,
          submitter: ids.admin,
          reviewer: ids.maintainer,
        }),
      ).rejects.toMatchObject({ constraint: "registry_versions_site_publisher" });
      await expect(
        version(c, {
          skill: ids.skill,
          publisher: "site",
          semver: "1.2.0",
          seq: 3,
          submitter: null,
        }),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("keeps every other version on its skill's publisher", async () => {
    await withClient(database().appUrl, async (c) => {
      await expect(
        version(c, {
          skill: ids.kobe,
          publisher: "maintainer",
          semver: "3.0.0",
          seq: 9,
          submitter: ids.admin,
          reviewer: ids.maintainer,
        }),
      ).rejects.toMatchObject({ code: "23503", constraint: "registry_versions_publisher_fk" });
      await expect(
        version(c, {
          skill: ids.skill,
          publisher: "kobe",
          semver: "3.0.0",
          seq: 9,
          submitter: null,
        }),
      ).rejects.toMatchObject({ code: "23503", constraint: "registry_versions_publisher_fk" });
      // A skill's publisher can't move away from its versions'.
      await expect(
        c.query(`UPDATE registry_skills SET publisher = 'site' WHERE id = $1`, [ids.skill]),
      ).rejects.toMatchObject({ code: "23503", constraint: "registry_versions_publisher_fk" });
    });
  });

  it("detaches only a Kobe skill, as a whole", async () => {
    await withClient(database().appUrl, async (c) => {
      const detach = (id: string, from: string | null) =>
        c.query(
          `UPDATE registry_skills SET detached_at = now(), detached_by = $2,
             detached_from_version = $3 WHERE id = $1`,
          [id, ids.admin, from],
        );
      await expect(detach(ids.skill, "1.0.0")).rejects.toMatchObject({
        constraint: "registry_skills_detached",
      });
      await expect(detach(ids.kobe, null)).rejects.toMatchObject({
        constraint: "registry_skills_detached",
      });
      await expect(detach(ids.kobe, "1.0")).rejects.toMatchObject({
        constraint: "registry_skills_detached",
      });
      await detach(ids.kobe, "1.0.0");
      await c.query(`UPDATE registry_skills SET kobe_shipped_version = '1.1.0' WHERE id = $1`, [
        ids.kobe,
      ]);
      // Reset to Kobe clears it as a whole.
      await expect(
        c.query(`UPDATE registry_skills SET detached_at = NULL WHERE id = $1`, [ids.kobe]),
      ).rejects.toMatchObject({ constraint: "registry_skills_detached" });
      await c.query(
        `UPDATE registry_skills SET detached_at = NULL, detached_by = NULL,
           detached_from_version = NULL, kobe_shipped_version = NULL WHERE id = $1`,
        [ids.kobe],
      );
    });
  });

  it("keeps one site draft per skill, seeded from one of its versions, with its files", async () => {
    await withClient(database().appUrl, async (c) => {
      // The base version must be the skill's own.
      await expect(
        c.query(
          `INSERT INTO site_skill_drafts (skill_id, base_version_id, created_by, updated_by)
           VALUES ($1, $2, $3, $3)`,
          [ids.skill, ids.kobeVersion, ids.admin],
        ),
      ).rejects.toMatchObject({ constraint: "site_skill_drafts_base_fk" });
      const d = await c.query<{ id: string }>(
        `INSERT INTO site_skill_drafts (skill_id, base_version_id, created_by, updated_by)
         VALUES ($1, $2, $3, $3) RETURNING id`,
        [ids.skill, ids.version, ids.admin],
      );
      const draft = d.rows[0]?.id;
      await expect(
        c.query(
          `INSERT INTO site_skill_drafts (skill_id, base_version_id, created_by, updated_by)
           VALUES ($1, $2, $3, $3)`,
          [ids.skill, ids.version, ids.admin],
        ),
      ).rejects.toMatchObject({ constraint: "site_skill_drafts_skill_unique" });
      await c.query(
        `INSERT INTO site_skill_draft_files (draft_id, path, text_content, size, updated_by)
         VALUES ($1, 'SKILL.md', 'hi', 2, $2)`,
        [draft, ids.admin],
      );
      await expect(
        c.query(
          `INSERT INTO site_skill_draft_files (draft_id, path, text_content, bytes, size, updated_by)
           VALUES ($1, 'x.bin', 'a', '\\x00', 1, $2)`,
          [draft, ids.admin],
        ),
      ).rejects.toMatchObject({ constraint: "site_skill_draft_files_one_content" });
      await c.query(`DELETE FROM site_skill_drafts WHERE id = $1`, [draft]);
      const left = await c.query(`SELECT 1 FROM site_skill_draft_files WHERE draft_id = $1`, [
        draft,
      ]);
      expect(left.rows).toHaveLength(0);
    });
  });

  it("names the Site admin on a site_published notification, and only there", async () => {
    await withClient(database().adminUrl, async (c) => {
      const notify = (kind: string, actor: string | null) =>
        c.query(
          `INSERT INTO notifications (team_id, user_id, kind, skill_id, skill_semver, actor_user_id)
           VALUES ($1, $2, $3, $4, '1.1.0', $5)`,
          [ids.team, ids.maintainer, kind, ids.skill, actor],
        );
      await expect(notify("skill.version.site_published", null)).rejects.toMatchObject({
        constraint: "notifications_actor",
      });
      await expect(notify("skill.version.deprecated", ids.admin)).rejects.toMatchObject({
        constraint: "notifications_actor",
      });
      await notify("skill.version.site_published", ids.admin);
    });
  });
});
