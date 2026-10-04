import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { BLOB_REF_COLUMNS } from "./blob-refs.js";
import { isTeamTable } from "./tenancy.js";
import * as schema from "./schema/index.js";

const tables = (Object.values(schema) as unknown[])
  .filter((v) => is(v, PgTable))
  .map((t) => getTableConfig(t as PgTable));

/** The client maps camelCase keys to snake_case columns (`casing: "snake_case"`). */
const snake = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe("blob-ref registry", () => {
  it("sees the schema's tables (so the check below is not vacuous)", () => {
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["users", "team_members"]));
  });

  it("names real columns of real tables (backups cross-check them against the bucket)", () => {
    for (const ref of BLOB_REF_COLUMNS) {
      const table = tables.find((t) => t.name === ref.table);
      expect(table, ref.table).toBeDefined();
      expect(
        table?.columns.map((c) => snake(c.name)),
        `${ref.table}.${ref.column}`,
      ).toContain(ref.column);
    }
  });

  it("lists each column once", () => {
    const keys = BLOB_REF_COLUMNS.map((r) => `${r.table}.${r.column}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("lists team tables only, and thread-owned columns on tables with thread_id (KOBE-18 purge)", () => {
    for (const ref of BLOB_REF_COLUMNS) {
      expect(isTeamTable(ref.table), ref.table).toBe(true);
      const columns = tables.find((t) => t.name === ref.table)?.columns.map((c) => snake(c.name));
      expect(columns, ref.table).toContain("team_id");
      if (ref.thread) expect(columns, ref.table).toContain("thread_id");
    }
  });
});
