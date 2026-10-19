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

  it("lists team tables (or marked site tables), and thread-owned columns with thread_id (KOBE-18 purge)", () => {
    for (const ref of BLOB_REF_COLUMNS) {
      const columns = tables.find((t) => t.name === ref.table)?.columns.map((c) => snake(c.name));
      if (ref.site) {
        expect(isTeamTable(ref.table), ref.table).toBe(false);
        expect(ref.thread, ref.table).toBeUndefined();
        continue;
      }
      expect(isTeamTable(ref.table), ref.table).toBe(true);
      expect(columns, ref.table).toContain("team_id");
      if (ref.thread) expect(columns, ref.table).toContain("thread_id");
    }
  });

  it("lists every object-key column in the schema (KOBE-423: backups verify their bytes)", () => {
    const listed = new Set(BLOB_REF_COLUMNS.map((r) => `${r.table}.${r.column}`));
    const keyLike = tables.flatMap((t) =>
      t.columns
        .map((c) => `${t.name}.${snake(c.name)}`)
        .filter((name) => KEY_LIKE.test(name.split(".")[1] ?? "")),
    );
    expect(keyLike.length).toBeGreaterThan(listed.size);
    const unlisted = keyLike.filter((name) => !listed.has(name) && !(name in NOT_OBJECT_KEYS));
    expect(unlisted, "add object-key columns to BLOB_REF_COLUMNS").toEqual([]);
    // No stale exemption: each still names a real column.
    for (const name of Object.keys(NOT_OBJECT_KEYS)) expect(keyLike, name).toContain(name);
  });
});

/** Names that object-key columns use: `blob_ref`, `blob_key`, `storage_key`, `*_key`, `key`, `ref`. */
const KEY_LIKE = /(^|_)(key|ref|blob_ref|blob_key|object_key)$/;

/** Key-named columns that hold no object-store key, with what they hold instead. */
const NOT_OBJECT_KEYS: Record<string, string> = {
  "events.ref": "a reference to the event's subject, not an object",
  "jwks.public_key": "a signing key",
  "jwks.private_key": "a signing key (encrypted)",
  "passkeys.public_key": "a WebAuthn credential key",
  "rate_limits.key": "a rate-limit bucket name",
  "retention_blob_deletions.key": "a key queued for deletion: its object is meant to go",
  "runs.client_key": "an idempotency key",
  "site_agents.gallery_key": "a gallery identifier",
  "site_budget_reservations.team_key": "a budget line key",
  "site_budget_reservations.member_key": "a budget line key",
  "site_settings.key": "a setting name",
  "skill_drafts.parent_ref": "the skill version a draft was forked from (ids and a hash)",
  "skill_draft_history.parent_ref": "a hold's copy of skill_drafts.parent_ref",
};
