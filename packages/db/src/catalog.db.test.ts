import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { INSTALL_WIDE_TABLES, TEAM_TABLES } from "./tenancy.js";

const owner = new pg.Pool({ connectionString: inject("ownerUrl") });
afterAll(() => owner.end());

async function rows<T extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await owner.query<T>(text, values)).rows;
}

describe("RLS catalog check (ac-1)", () => {
  it("classifies every table in the public schema as team-owned or install-wide", async () => {
    const tables = await rows<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
    );
    const known = new Set<string>([...TEAM_TABLES, ...INSTALL_WIDE_TABLES]);
    expect(tables.map((t) => t.relname).filter((name) => !known.has(name))).toEqual([]);
    expect(tables.length).toBeGreaterThan(0);
  });

  it.each(TEAM_TABLES)("%s exists with ENABLE + FORCE ROW LEVEL SECURITY", async (table) => {
    const [row] = await rows<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)`,
      [`public.${table}`],
    );
    expect(row, `${table} must exist`).toBeDefined();
    expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it.each(TEAM_TABLES)("%s only has policies bound to kobe.team_id", async (table) => {
    const policies = await rows<{
      polcmd: string;
      permissive: boolean;
      qual: string | null;
      check: string | null;
    }>(
      `SELECT polcmd, polpermissive AS permissive,
              pg_get_expr(polqual, polrelid) AS qual, pg_get_expr(polwithcheck, polrelid) AS check
       FROM pg_policy WHERE polrelid = to_regclass($1)`,
      [`public.${table}`],
    );
    expect(policies.length).toBeGreaterThan(0);
    // Permissive policies are OR-ed: any one not bound to the team setting would leak rows.
    for (const p of policies.filter((p) => p.permissive)) {
      expect(p.qual ?? "").toContain("kobe.team_id");
      if (p.polcmd === "*" || p.polcmd === "a" || p.polcmd === "w") {
        expect(p.check ?? p.qual ?? "").toContain("kobe.team_id");
      }
    }
    expect(
      policies.some((p) => p.permissive && p.polcmd === "*" && p.check?.includes("kobe.team_id")),
    ).toBe(true);
  });

  it.each(TEAM_TABLES)("%s.team_id is uuid NOT NULL", async (table) => {
    const [col] = await rows<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'team_id'`,
      [table],
    );
    expect(col).toEqual({ data_type: "uuid", is_nullable: "NO" });
  });

  it.each(TEAM_TABLES)("%s has an index led by team_id", async (table) => {
    const indexes = await rows<{ indexrelid: string }>(
      `SELECT i.indexrelid::regclass::text AS indexrelid
       FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
       WHERE i.indrelid = to_regclass($1) AND a.attname = 'team_id'`,
      [`public.${table}`],
    );
    expect(indexes.length).toBeGreaterThan(0);
  });

  it("app role is not superuser, cannot bypass RLS, and owns no tables", async () => {
    const appRole = inject("appRole");
    const [role] = await rows<{ rolsuper: boolean; rolbypassrls: boolean; owned: string }>(
      `SELECT r.rolsuper, r.rolbypassrls,
              (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid)::text AS owned
       FROM pg_roles r WHERE r.rolname = $1`,
      [appRole],
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, owned: "0" });
  });
});
