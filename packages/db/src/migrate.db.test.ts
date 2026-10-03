import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { DEFAULT_MIGRATIONS_FOLDER, runMigrations } from "./migrate.js";

const admin = new pg.Pool({ connectionString: inject("adminUrl") });
afterAll(() => admin.end());

describe("runMigrations role checks", () => {
  it("refuses to run as a superuser (FORCE RLS does not bind superusers)", async () => {
    await expect(
      runMigrations({ databaseUrl: inject("adminUrl"), appRole: inject("appRole") }),
    ).rejects.toThrow(/superuser/);
  });

  it("refuses an app role that is a member of the owner role", async () => {
    const suffix = randomBytes(4).toString("hex");
    const sneaky = `kobe_sneaky_${suffix}`;
    await admin.query(
      `CREATE ROLE ${sneaky} LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${inject("ownerRole")}`,
    );
    try {
      await expect(
        runMigrations({ databaseUrl: inject("ownerUrl"), appRole: sneaky }),
      ).rejects.toThrow(/member/);
    } finally {
      await admin.query(`DROP ROLE ${sneaky}`);
    }
  });

  it("refuses to use the app role itself for migrations", async () => {
    await expect(
      runMigrations({ databaseUrl: inject("appUrl"), appRole: inject("appRole") }),
    ).rejects.toThrow(/owner role, not the app role/);
  });

  it("is idempotent when re-run as the owner", async () => {
    await expect(
      runMigrations({ databaseUrl: inject("ownerUrl"), appRole: inject("appRole") }),
    ).resolves.toBeUndefined();
  });

  it("reports the notices migrations raise (upgrade notes in the Job log)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kobe-migrations-"));
    try {
      await cp(DEFAULT_MIGRATIONS_FOLDER, dir, { recursive: true });
      const journalPath = path.join(dir, "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
        entries: { idx: number; when: number; tag: string }[];
      };
      const last = journal.entries.at(-1);
      const tag = "9999_notice_probe";
      journal.entries.push({
        ...(last as object),
        idx: (last?.idx ?? 0) + 1,
        when: (last?.when ?? 0) + 1,
        tag,
      } as never);
      await writeFile(journalPath, JSON.stringify(journal));
      await writeFile(
        path.join(dir, `${tag}.sql`),
        "DO $$ BEGIN RAISE NOTICE 'kobe: probe notice'; END $$;",
      );
      const notices: string[] = [];
      await runMigrations({
        databaseUrl: inject("ownerUrl"),
        appRole: inject("appRole"),
        migrationsFolder: dir,
        onNotice: (message) => notices.push(message),
      });
      expect(notices).toContain("kobe: probe notice");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
