import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { registrySkills, registryVersions } from "./registry.js";
import { SKILL_DRAFT_MAX_BYTES, SKILL_DRAFT_MAX_FILES } from "./skill-drafts.js";

// Site drafts of catalog skills (KOBE-495): the Site Console's working copy of a catalog skill,
// seeded from one of its versions and published as a new catalog version by a Site admin.
// Site-wide (†): a catalog skill belongs to the Site, so its draft does too; no team data, no team
// RLS (the server lets only Site admins read or write them, re-checked on every call). Kept apart
// from the Workbench's team drafts (`skill-drafts.ts`) so the team policies stay as they are. The
// limits are the Workbench's (SK11): text inline, other files as bytea.

/** Mirrors the Workbench drafts' 240-byte package paths. */
const PATH_MAX_BYTES = 240;

const ts = () => timestamp({ withTimezone: true });

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * Site-wide (†): the one site draft of a catalog skill (any Site admin may continue it). `rev`
 * rises by one on every change (the server's compare-and-set, as the Workbench's); `size_bytes`
 * and `file_count` follow the files (the server writes them in the same transaction). The base
 * version is always one of the skill's own (composite key). Deleted once published or discarded.
 */
export const siteSkillDrafts = pgTable(
  "site_skill_drafts",
  {
    id: uuid().primaryKey().defaultRandom(),
    skillId: uuid()
      .notNull()
      .references(() => registrySkills.id),
    baseVersionId: uuid().notNull(),
    rev: integer().notNull().default(1),
    sizeBytes: integer().notNull().default(0),
    fileCount: integer().notNull().default(0),
    // Users are deactivated, never deleted (NO ACTION).
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: ts().notNull().defaultNow(),
    updatedBy: uuid()
      .notNull()
      .references(() => users.id),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    unique("site_skill_drafts_skill_unique").on(t.skillId),
    foreignKey({
      name: "site_skill_drafts_base_fk",
      columns: [t.baseVersionId, t.skillId],
      foreignColumns: [registryVersions.id, registryVersions.skillId],
    }),
    check("site_skill_drafts_rev_positive", sql`${t.rev} > 0`),
    check(
      "site_skill_drafts_size",
      sql`${t.sizeBytes} BETWEEN 0 AND ${sql.raw(String(SKILL_DRAFT_MAX_BYTES))} AND ${t.fileCount} BETWEEN 0 AND ${sql.raw(String(SKILL_DRAFT_MAX_FILES))}`,
    ),
  ],
);

/**
 * Site-wide (†): one file of a site draft, by its package path. Exactly one of `text_content`
 * (valid UTF-8 without NUL) and `bytes` is set; `size` is its byte length.
 */
export const siteSkillDraftFiles = pgTable(
  "site_skill_draft_files",
  {
    draftId: uuid()
      .notNull()
      .references(() => siteSkillDrafts.id, { onDelete: "cascade" }),
    path: text().notNull(),
    textContent: text(),
    bytes: bytea(),
    size: integer().notNull(),
    updatedAt: ts().notNull().defaultNow(),
    updatedBy: uuid()
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    primaryKey({ columns: [t.draftId, t.path] }),
    index("site_skill_draft_files_writer_idx").on(t.updatedBy),
    check(
      "site_skill_draft_files_path_size",
      sql`octet_length(${t.path}) BETWEEN 1 AND ${sql.raw(String(PATH_MAX_BYTES))}`,
    ),
    check(
      "site_skill_draft_files_one_content",
      sql`(${t.textContent} IS NULL) <> (${t.bytes} IS NULL)`,
    ),
    check(
      "site_skill_draft_files_size",
      sql`${t.size} = COALESCE(octet_length(${t.textContent}), octet_length(${t.bytes})) AND ${t.size} <= ${sql.raw(String(SKILL_DRAFT_MAX_BYTES))}`,
    ),
  ],
);
