import { describe, expect, it } from "vitest";
import { restorePostlude, restorePrelude, type RestorePlan } from "./restore-sql.js";

const plan: RestorePlan = {
  lockKey: 42,
  migrations: [
    { hash: "a".repeat(64), createdAt: 1 },
    { hash: "b".repeat(64), createdAt: 2 },
  ],
  lockTables: ["sessions", "team_members", "users"],
  loadTables: [
    { name: "team_members", rows: 3 },
    { name: "users", rows: 2 },
  ],
  forcedRls: ["team_members"],
  userTriggers: [
    { table: "users", trigger: 'audit "x"', mode: "O" },
    { table: "team_members", trigger: "always_one", mode: "A" },
  ],
  immediateForeignKeys: [
    { table: "threads", constraint: "threads_leaf_entry_fk" },
    { table: "thread_entries", constraint: "thread_entries_thread_fk" },
  ],
};

describe("restore prelude", () => {
  const sql = restorePrelude(plan);

  it("opens one transaction and takes the migration lock without waiting", () => {
    expect(sql.startsWith("BEGIN;")).toBe(true);
    expect(sql).toContain("pg_try_advisory_xact_lock(42)");
  });

  it("locks every table before changing anything", () => {
    expect(sql).toContain(
      'LOCK TABLE public."sessions", public."team_members", public."users" IN ACCESS EXCLUSIVE MODE;',
    );
    expect(sql.indexOf("LOCK TABLE")).toBeLessThan(sql.indexOf("NO FORCE"));
  });

  it("lifts FORCE RLS (owner only; the app role stays bound) before checking for data", () => {
    expect(sql).toContain('ALTER TABLE public."team_members" NO FORCE ROW LEVEL SECURITY;');
    expect(sql).not.toContain('ALTER TABLE public."users" NO FORCE');
    expect(sql.indexOf("NO FORCE")).toBeLessThan(sql.indexOf("already has data"));
  });

  it("disables enabled user triggers, quoting their names", () => {
    expect(sql).toContain('ALTER TABLE public."users" DISABLE TRIGGER "audit ""x""";');
    expect(sql).toContain('ALTER TABLE public."team_members" DISABLE TRIGGER "always_one";');
  });

  it("checks the applied migrations and that loaded tables are empty, inside the transaction", () => {
    expect(sql).toContain(`'${"a".repeat(64)}:1,${"b".repeat(64)}:2'`);
    expect(sql).toContain("drizzle.__drizzle_migrations");
    expect(sql).toContain('EXISTS (SELECT 1 FROM public."users")');
    expect(sql).not.toContain('FROM public."sessions")');
  });

  it("defers immediate foreign keys for the load, so FK cycles (threads ⇄ entries) load in any order", () => {
    expect(sql).toContain(
      'ALTER TABLE public."threads" ALTER CONSTRAINT "threads_leaf_entry_fk" DEFERRABLE INITIALLY DEFERRED;',
    );
    expect(sql).toContain("SET CONSTRAINTS ALL DEFERRED;");
  });

  it("rejects unsafe table names", () => {
    expect(() => restorePrelude({ ...plan, lockTables: ['x"; DROP'] })).toThrow(/Invalid/);
  });
});

describe("restore postlude", () => {
  const sql = restorePostlude(plan);

  it("verifies every table's row count before committing", () => {
    expect(sql).toContain('SELECT count(*) INTO n FROM public."team_members"');
    expect(sql).toContain("IF n <> 3 THEN");
    expect(sql).toContain("IF n <> 2 THEN");
  });

  it("checks deferred foreign keys, then makes them immediate again", () => {
    expect(sql.indexOf("SET CONSTRAINTS ALL IMMEDIATE;")).toBeGreaterThan(-1);
    expect(sql.indexOf("SET CONSTRAINTS ALL IMMEDIATE;")).toBeLessThan(
      sql.indexOf('ALTER CONSTRAINT "threads_leaf_entry_fk" NOT DEFERRABLE INITIALLY IMMEDIATE;'),
    );
    expect(sql.indexOf("NOT DEFERRABLE")).toBeLessThan(sql.indexOf("COMMIT;"));
  });

  it("re-enables triggers in their original mode and re-forces RLS, then commits", () => {
    expect(sql).toContain('ALTER TABLE public."users" ENABLE TRIGGER "audit ""x""";');
    expect(sql).toContain('ALTER TABLE public."team_members" ENABLE ALWAYS TRIGGER "always_one";');
    expect(sql).toContain('ALTER TABLE public."team_members" FORCE ROW LEVEL SECURITY;');
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(sql.indexOf("count(*)")).toBeLessThan(sql.indexOf("FORCE ROW LEVEL SECURITY"));
  });

  it("records the restore in the audit log after the triggers are back (KOBE-15)", () => {
    expect(sql).not.toContain("audit_log");
    const audited = restorePostlude({
      ...plan,
      audit: { backupCreatedAt: "2026-10-02T12:00:00.000Z", tables: 12, rows: 34 },
    });
    const insert = audited.indexOf("INSERT INTO public.audit_log");
    expect(insert).toBeGreaterThan(audited.indexOf('ENABLE TRIGGER "audit ""x""";'));
    expect(insert).toBeLessThan(audited.indexOf("COMMIT;"));
    expect(audited).toContain(
      `'platform.restore.completed', '{"backupCreatedAt":"2026-10-02T12:00:00.000Z","tables":12,"rows":34}'::jsonb`,
    );
  });
});
