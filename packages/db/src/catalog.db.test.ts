import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { BREAK_GLASS_READABLE_TABLES } from "./break-glass/tables.js";
import {
  INSTALL_WIDE_COLUMN_GRANTS,
  INSTALL_WIDE_TABLES,
  TEAM_REFERENCING_INSTALL_WIDE,
  TEAM_TABLES,
  appPrivilegesFor,
} from "./tenancy.js";

/** pg_get_expr rendering of the one allowed team policy (USING and WITH CHECK). */
const CANONICAL_TEAM_EXPR =
  "(team_id = (NULLIF(current_setting('kobe.team_id'::text, true), ''::text))::uuid)";

/** Whitespace-insensitive form of a pg_get_expr / pg_get_functiondef rendering. */
const squash = (text: string | null): string | null =>
  text === null ? null : text.replace(/\s+/g, " ").trim();

const GRANT = "( SELECT g.%s FROM break_glass_active_grant() g(team_id, user_id, thread_id))";
const g = (column: string) => GRANT.replace("%s", column);

/** Same shape as thread_entries' for a table keyed by (team_id, thread_id). */
const threadBound = (table: string) =>
  `((team_id = ${g("team_id")}) AND (thread_id = COALESCE(${g("thread_id")}, thread_id)) ` +
  `AND ((${g("user_id")} IS NULL) OR (EXISTS ( SELECT 1 FROM threads t WHERE ((t.team_id = ${table}.team_id) ` +
  `AND (t.id = ${table}.thread_id) AND (t.owner_user_id = ${g("user_id")}))))))`;

/** The exact `break_glass_read` USING clause per readable table (D10, KOBE-16). */
const BREAK_GLASS_QUALS: Record<string, string> = {
  threads:
    `((team_id = ${g("team_id")}) AND (owner_user_id = COALESCE(${g("user_id")}, owner_user_id)) ` +
    `AND (id = COALESCE(${g("thread_id")}, id)))`,
  thread_entries:
    `((team_id = ${g("team_id")}) AND (thread_id = COALESCE(${g("thread_id")}, thread_id)) ` +
    `AND ((${g("user_id")} IS NULL) OR (EXISTS ( SELECT 1 FROM threads t WHERE ((t.team_id = thread_entries.team_id) ` +
    `AND (t.id = thread_entries.thread_id) AND (t.owner_user_id = ${g("user_id")}))))))`,
  artifacts: threadBound("artifacts"),
  artifact_versions: threadBound("artifact_versions"),
  files: threadBound("files"),
  // Memory is not thread content (KOBE-154): team grants only, user grants by owner.
  memory_docs:
    `((team_id = ${g("team_id")}) AND (${g("thread_id")} IS NULL) AND ` +
    `((${g("user_id")} IS NULL) OR (owner_user_id = ${g("user_id")})))`,
  memory_doc_versions:
    `((team_id = ${g("team_id")}) AND (${g("thread_id")} IS NULL) AND ` +
    `((${g("user_id")} IS NULL) OR (EXISTS ( SELECT 1 FROM memory_docs d WHERE ((d.team_id = memory_doc_versions.team_id) ` +
    `AND (d.id = memory_doc_versions.doc_id) AND (d.owner_user_id = ${g("user_id")}))))))`,
  // Project files are team content, not thread content (KOBE-160): team grants, user grants by adder.
  project_files:
    `((team_id = ${g("team_id")}) AND (${g("thread_id")} IS NULL) AND ` +
    `((${g("user_id")} IS NULL) OR (added_by = ${g("user_id")})))`,
};

/** Schemas Kobe never creates objects in; everything else is scanned. */
const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast", "drizzle"];

const owner = new pg.Pool({ connectionString: inject("ownerUrl") });
afterAll(() => owner.end());

async function rows<T extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await owner.query<T>(text, values)).rows;
}

interface Relation {
  schema: string;
  name: string;
  relkind: string;
  ispartition: boolean;
  rls: boolean;
  force: boolean;
}

async function relations(): Promise<Relation[]> {
  return rows<Relation>(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
            c.relispartition AS ispartition, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND n.nspname <> ALL($1) AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast%'
     ORDER BY 1, 2`,
    [SYSTEM_SCHEMAS],
  );
}

describe("RLS catalog check (ac-1)", () => {
  it("has at least one team table to check (guards against vacuous passes)", () => {
    expect(TEAM_TABLES.length).toBeGreaterThan(0);
  });

  it("only has plain or partitioned tables, all in the public schema", async () => {
    const odd = (await relations()).filter(
      (r) => r.schema !== "public" || !["r", "p"].includes(r.relkind),
    );
    // Views, materialized views and foreign tables can't enforce team RLS; add one only with a
    // dedicated check (e.g. security_invoker views).
    expect(odd).toEqual([]);
  });

  it("classifies every top-level table as team-owned or install-wide", async () => {
    const known = new Set<string>([...TEAM_TABLES, ...INSTALL_WIDE_TABLES]);
    const tables = (await relations()).filter((r) => !r.ispartition);
    expect(tables.map((t) => t.name).filter((name) => !known.has(name))).toEqual([]);
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining([...TEAM_TABLES]));
  });

  it("keeps team_id and team foreign keys out of install-wide tables unless allowlisted", async () => {
    const referencing = await rows<{ table: string }>(
      `SELECT DISTINCT c.relname AS table
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND (
         EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'team_id' AND NOT a.attisdropped)
         OR EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f'
                    AND k.confrelid = 'public.teams'::regclass))
       ORDER BY 1`,
    );
    const allowed = new Set<string>([
      ...TEAM_TABLES,
      ...Object.keys(TEAM_REFERENCING_INSTALL_WIDE),
    ]);
    expect(referencing.map((r) => r.table).filter((t) => !allowed.has(t))).toEqual([]);
  });

  it("enables and forces RLS on every team table and each of its partitions", async () => {
    const team = new Set<string>(TEAM_TABLES);
    const partitions = await rows<{ child: string; parent: string }>(
      `SELECT c.relname AS child, p.relname AS parent
       FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent`,
    );
    const parentOf = new Map(partitions.map((p) => [p.child, p.parent]));
    const governed = (await relations()).filter(
      (r) => team.has(r.name) || team.has(parentOf.get(r.name) ?? ""),
    );
    expect(governed.filter((r) => !r.rls || !r.force).map((r) => r.name)).toEqual([]);
  });

  it.each(TEAM_TABLES)(
    "%s has the canonical team policy for PUBLIC, plus only the break-glass SELECT policy if listed",
    async (table) => {
      const policies = await rows<{
        name: string;
        cmd: string;
        permissive: boolean;
        roles: string;
        qual: string;
        check: string | null;
      }>(
        `SELECT polname AS name, polcmd::text AS cmd, polpermissive AS permissive, polroles::text AS roles,
              pg_get_expr(polqual, polrelid) AS qual, pg_get_expr(polwithcheck, polrelid) AS check
       FROM pg_policy WHERE polrelid = to_regclass($1) ORDER BY polname`,
        [`public.${table}`],
      );
      const canonical = {
        name: "team_isolation",
        cmd: "*",
        permissive: true,
        roles: "{0}",
        qual: CANONICAL_TEAM_EXPR,
        check: CANONICAL_TEAM_EXPR,
      };
      if (!(BREAK_GLASS_READABLE_TABLES as readonly string[]).includes(table)) {
        expect(policies).toEqual([canonical]);
        return;
      }
      // D10: SELECT only (cmd r, no WITH CHECK), exactly this USING clause; never a write path.
      expect(policies.map((p) => ({ ...p, qual: squash(p.qual) }))).toEqual([
        {
          name: "break_glass_read",
          cmd: "r",
          permissive: true,
          roles: "{0}",
          qual: BREAK_GLASS_QUALS[table],
          check: null,
        },
        { ...canonical, qual: squash(CANONICAL_TEAM_EXPR) },
      ]);
    },
  );

  it.each(TEAM_TABLES)("%s.team_id is uuid NOT NULL", async (table) => {
    const [col] = await rows<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'team_id'`,
      [table],
    );
    expect(col).toEqual({ data_type: "uuid", is_nullable: "NO" });
  });

  it.each(TEAM_TABLES)("%s has an index led by team_id", async (table) => {
    const indexes = await rows<{ name: string }>(
      `SELECT i.indexrelid::regclass::text AS name
       FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
       WHERE i.indrelid = to_regclass($1) AND a.attname = 'team_id'`,
      [`public.${table}`],
    );
    expect(indexes.length).toBeGreaterThan(0);
  });

  it("checks a break-glass grant per statement, for the named active admin (KOBE-16)", async () => {
    const [fn] = await rows<{ def: string; volatility: string; definer: boolean }>(
      `SELECT pg_get_functiondef(p.oid) AS def, p.provolatile::text AS volatility, p.prosecdef AS definer
       FROM pg_proc p WHERE p.oid = 'public.break_glass_active_grant'::regproc`,
    );
    expect(fn?.definer).toBe(false);
    expect(fn?.volatility).toBe("s");
    const body = squash(fn?.def ?? "") ?? "";
    for (const clause of [
      "g.id = NULLIF(current_setting('kobe.break_glass_grant', true), '')::uuid",
      "g.admin_id = NULLIF(current_setting('kobe.break_glass_actor', true), '')::uuid",
      "g.status = 'approved'",
      "g.starts_at <= statement_timestamp() AND g.expires_at > statement_timestamp()",
      'JOIN "public"."users" u ON u.id = g.admin_id AND u.deactivated_at IS NULL',
      'JOIN "public"."install_roles" r ON r.user_id = g.admin_id',
    ]) {
      expect(body).toContain(clause);
    }
  });

  it("has no SECURITY DEFINER functions outside system schemas", async () => {
    const definers = await rows<{ name: string }>(
      `SELECT n.nspname || '.' || p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prosecdef AND n.nspname <> ALL($1)`,
      [SYSTEM_SCHEMAS],
    );
    expect(definers).toEqual([]);
  });
});

describe("app role privileges", () => {
  const appRole = inject("appRole");

  it("is not superuser, cannot bypass RLS, and owns nothing", async () => {
    const [role] = await rows<{ rolsuper: boolean; rolbypassrls: boolean; owned: number }>(
      `SELECT r.rolsuper, r.rolbypassrls, (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owned
       FROM pg_roles r WHERE r.rolname = $1`,
      [appRole],
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, owned: 0 });
  });

  it("is not a member of the owner role or of any data-bypassing predefined role", async () => {
    const memberships = await rows<{ role: string }>(
      `SELECT g.rolname AS role FROM pg_roles g
       WHERE g.rolname <> $1 AND pg_has_role($1, g.oid, 'MEMBER')`,
      [appRole],
    );
    expect(memberships).toEqual([]);
  });

  it("cannot create objects in the database or the public schema", async () => {
    const [p] = await rows<{ schema_create: boolean; db_create: boolean; db_temp: boolean }>(
      `SELECT has_schema_privilege($1, 'public', 'CREATE') AS schema_create,
              has_database_privilege($1, current_database(), 'CREATE') AS db_create,
              has_database_privilege($1, current_database(), 'TEMP') AS db_temp`,
      [appRole],
    );
    expect(p).toEqual({ schema_create: false, db_create: false, db_temp: false });
  });

  it("can only append to and read audit_log, and erase its IP and user agent (KOBE-15, KOBE-17)", async () => {
    const [p] = await rows<Record<string, boolean>>(
      `SELECT ${["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]
        .map((p) => `has_table_privilege($1, 'public.audit_log', '${p}') AS "${p}"`)
        .join(", ")}`,
      [appRole],
    );
    expect(p).toEqual({
      SELECT: true,
      INSERT: true,
      UPDATE: false,
      DELETE: false,
      TRUNCATE: false,
      REFERENCES: false,
      TRIGGER: false,
    });
    const triggers = await rows<{ name: string; enabled: string }>(
      `SELECT tgname AS name, tgenabled::text AS enabled FROM pg_trigger
       WHERE tgrelid = 'public.audit_log'::regclass AND NOT tgisinternal ORDER BY 1`,
    );
    expect(triggers).toEqual([
      { name: "audit_log_append", enabled: "O" },
      { name: "audit_log_erase_pii", enabled: "O" },
      { name: "audit_log_refuse_delete", enabled: "O" },
      { name: "audit_log_refuse_truncate", enabled: "O" },
    ]);
    const [erasable] = await rows<Record<string, boolean>>(
      `SELECT ${["ip", "user_agent", "pii_salt", "pii_commitment", "hash", "target", "at"]
        .map((c) => `has_column_privilege($1, 'public.audit_log', '${c}', 'UPDATE') AS "${c}"`)
        .join(", ")}`,
      [appRole],
    );
    expect(erasable).toEqual({
      ip: true,
      user_agent: true,
      pii_salt: true,
      pii_commitment: false,
      hash: false,
      target: false,
      at: false,
    });
  });

  it("holds exactly the column privileges in the registry", async () => {
    const columnGrants = await rows<{ table: string; column: string; privilege: string }>(
      `SELECT c.relname AS table, a.attname AS column, p.privilege_type AS privilege
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(a.attacl) p
       WHERE n.nspname = 'public' AND p.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
       ORDER BY 1, 3, 2`,
      [appRole],
    );
    const expected = Object.entries(INSTALL_WIDE_COLUMN_GRANTS)
      .flatMap(([table, grants]) =>
        Object.entries(grants ?? {}).flatMap(([privilege, columns]) =>
          (columns ?? []).map((column) => ({ table, column, privilege })),
        ),
      )
      .sort((a, b) =>
        `${a.table}|${a.privilege}|${a.column}`.localeCompare(
          `${b.table}|${b.privilege}|${b.column}`,
        ),
      );
    expect(columnGrants).toEqual(expected);
  });

  it("holds exactly the privileges in the grants matrix on every table", async () => {
    const tables = (await relations()).filter((r) => r.schema === "public");
    const grants = await rows<{ table: string; privilege: string }>(
      `SELECT table_name AS table, privilege_type AS privilege FROM information_schema.role_table_grants
       WHERE grantee = $1 AND table_schema = 'public'`,
      [appRole],
    );
    const actual = Object.fromEntries(
      tables.map((t) => [
        t.name,
        grants
          .filter((g) => g.table === t.name)
          .map((g) => g.privilege)
          .sort(),
      ]),
    );
    const expected = Object.fromEntries(
      tables.map((t) => [t.name, [...(appPrivilegesFor(t.name) ?? [])].sort()]),
    );
    expect(actual).toEqual(expected);
  });
});
