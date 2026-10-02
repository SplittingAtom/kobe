import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { runMigrations } from "./migrate.js";

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
});
