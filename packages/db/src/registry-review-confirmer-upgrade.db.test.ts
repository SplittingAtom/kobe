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
 * KOBE-334 review M2 (0158, 0163): an install with reviewed catalog versions upgrades; afterwards
 * the Team admin who confirmed a promotion approves it only on a single-admin Site, and the
 * version is flagged `self_approved`; the confirmer may still reject; a second reviewer takes the
 * exception away.
 */
const MARKER = `"registry_versions"."approved_at" IS NULL`;

let db: TestDatabase | undefined;
let oldMigrations = "";
const suffix = randomBytes(4).toString("hex");
const ids = {
  admin: randomUUID(),
  builder: randomUUID(),
  second: randomUUID(),
  skill: randomUUID(),
  approved: "",
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

const insertVersion = (c: pg.Client, semver: string, seq: number, confirmedBy?: string) =>
  c
    .query<{ id: string }>(
      `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash, manifest,
         provenance, source, scan, verdict, state, submitted_by)
       VALUES ($1, $2, $3, repeat('a', 64), repeat('b', 64), '{}', $4, '{}', '{}', 'pass',
         'in_review', $5) RETURNING id`,
      [
        ids.skill,
        semver,
        seq,
        JSON.stringify(confirmedBy ? { confirmedBy: { userId: confirmedBy } } : {}),
        ids.builder,
      ],
    )
    .then((r) => r.rows[0]?.id as string);

const approve = (c: pg.Client, id: string, by: string) =>
  c.query(
    `UPDATE registry_versions SET state = 'approved', reviewed_by = $2, approved_at = now()
      WHERE id = $1 RETURNING self_approved`,
    [id, by],
  );

beforeAll(async () => {
  oldMigrations = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: oldMigrations });
  await withClient(db.adminUrl, async (c) => {
    for (const [id, name] of [
      [ids.admin, "admin"],
      [ids.builder, "builder"],
      [ids.second, "second"],
    ] as const)
      await c.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
        id,
        name,
        `${name}-${suffix}@example.test`,
      ]);
    await c.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [ids.admin]);
    await c.query(`INSERT INTO registry_skills (id, name, summary) VALUES ($1, $2, 'S')`, [
      ids.skill,
      `upg-${suffix}`,
    ]);
    // Reviewed before the upgrade: an ordinary approval.
    ids.approved = await insertVersion(c, "0.1.0", 1);
    await approve(c, ids.approved, ids.admin);
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("the confirming Team admin's approval (KOBE-334 review M2)", () => {
  it("keeps old reviews and flags a single admin's approval of what it confirmed", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      const old = await c.query(`SELECT self_approved FROM registry_versions WHERE id = $1`, [
        ids.approved,
      ]);
      expect(old.rows).toEqual([{ self_approved: false }]);

      const rejected = await insertVersion(c, "0.2.0", 2, ids.admin);
      await c.query(
        `UPDATE registry_versions SET state = 'rejected', reviewed_by = $2 WHERE id = $1`,
        [rejected, ids.admin],
      );
      const flagged = await insertVersion(c, "0.3.0", 3, ids.admin);
      expect((await approve(c, flagged, ids.admin)).rows).toEqual([{ self_approved: true }]);

      await c.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [ids.second]);
      const refused = await insertVersion(c, "0.4.0", 4, ids.admin);
      // As the app role, as the server writes it (review-335 L7).
      if (!db) throw new Error("database not created");
      await withClient(db.appUrl, async (app) => {
        await expect(approve(app, refused, ids.admin)).rejects.toThrow(/second reviewer/);
      });
      expect((await approve(c, refused, ids.second)).rows).toEqual([{ self_approved: false }]);
      // The flag can't be set by hand on someone else's approval.
      await expect(
        c.query(`UPDATE registry_versions SET self_approved = true WHERE id = $1`, [refused]),
      ).rejects.toThrow();
    });
  });
});
