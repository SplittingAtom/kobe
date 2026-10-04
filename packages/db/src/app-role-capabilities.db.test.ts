import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import pg from "pg";

/**
 * The trigger guards that allow a write only from a nested trigger (`pg_trigger_depth() > 1`:
 * 0005 counters, 0020 agent versions, run_usage append-only, KOBE-42 spend counters and alert
 * emails) are sound only while the app role cannot run trigger code of its own. A reviewer
 * showed the bypass as superuser: a temp table whose trigger calls a pg_temp function that writes
 * a guarded table runs at depth 2. migrate.ts revokes CREATE on schema public and CREATE,
 * TEMPORARY on the database from PUBLIC; this proves it holds for the real app role, through any
 * membership, and that the attack is refused at its first step.
 */
let app: pg.Client;

beforeAll(async () => {
  app = new pg.Client({ connectionString: inject("appUrl") });
  await app.connect();
});
afterAll(() => app.end());

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e as { code?: string }).code,
  );

describe("the app role cannot run trigger code of its own", () => {
  it("holds no TEMPORARY or CREATE on the database, CREATE on public, or TRIGGER on any table", async () => {
    const { rows } = await app.query<{
      temp: boolean;
      create: boolean;
      schema: boolean;
      triggers: number;
    }>(
      `SELECT has_database_privilege(current_user, current_database(), 'TEMPORARY') AS temp,
              has_database_privilege(current_user, current_database(), 'CREATE') AS create,
              has_schema_privilege(current_user, 'public', 'CREATE') AS schema,
              (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
                  AND has_table_privilege(current_user, c.oid, 'TRIGGER')) AS triggers`,
    );
    expect(rows[0]).toEqual({ temp: false, create: false, schema: false, triggers: 0 });
  });

  it("refuses the temp-table / nested-trigger attack at its first step", async () => {
    // 42501: insufficient privilege.
    expect(await code(app.query("CREATE TEMP TABLE kobe_attack (x int)"))).toBe("42501");
    expect(
      await code(
        app.query(`CREATE FUNCTION pg_temp.kobe_attack() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN UPDATE run_usage SET input_tokens = 0; RETURN NULL; END $$`),
      ),
    ).toBe("42501");
    expect(
      await code(
        app.query(`CREATE FUNCTION public.kobe_attack() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN UPDATE run_usage SET input_tokens = 0; RETURN NULL; END $$`),
      ),
    ).toBe("42501");
    expect(
      await code(
        app.query(`CREATE TRIGGER kobe_attack AFTER INSERT ON run_usage
          FOR EACH STATEMENT EXECUTE FUNCTION kobe_run_usage_append_only()`),
      ),
    ).toBe("42501");
  });
});
