import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";

const owner = new pg.Pool({ connectionString: inject("ownerUrl") });
afterAll(() => owner.end());

describe("app role access to the drizzle schema", () => {
  it("is limited to USAGE on the schema and SELECT on the grants marker", async () => {
    const appRole = inject("appRole");
    const { rows: schema } = await owner.query<{ usage: boolean; create: boolean }>(
      `SELECT has_schema_privilege($1, 'drizzle', 'USAGE') AS usage,
              has_schema_privilege($1, 'drizzle', 'CREATE') AS create`,
      [appRole],
    );
    expect(schema[0]).toEqual({ usage: true, create: false });
    const { rows } = await owner.query<{ table: string; privilege: string }>(
      `SELECT table_name AS table, privilege_type AS privilege FROM information_schema.role_table_grants
       WHERE grantee = $1 AND table_schema = 'drizzle' ORDER BY 1, 2`,
      [appRole],
    );
    expect(rows).toEqual([{ table: "kobe_grants_applied", privilege: "SELECT" }]);
  });

  it("records which migration the app-role grants were applied for", async () => {
    const { rows } = await owner.query<{ marker: string; latest: string }>(
      `SELECT (SELECT migration_when::text FROM drizzle.kobe_grants_applied) AS marker,
              (SELECT max(created_at)::text FROM drizzle.__drizzle_migrations) AS latest`,
    );
    expect(rows[0]?.marker).toBe(rows[0]?.latest);
  });
});
