import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Workbench drafts (KOBE-320, spec SK10, SK11): a member's mutable working copy of a skill, owned
// by (author, team). Team tables: team_id NOT NULL, ENABLE + FORCE RLS with the canonical policy
// and a break-glass read (custom migration `*_skill_drafts_rls.sql`). Private to the author unless
// shared with the team's Builders and Team admins (the server decides who reads and writes; RLS
// keeps teams apart). The whole draft lives in Postgres: text files inline, other files as bytea,
// at most SKILL_DRAFT_MAX_BYTES together. Drafts follow team retention (by last change) and
// offboarding (a departed author's drafts, 30 days after the departure).
//
// Legal hold (D18), the KOBE-275 history pattern: a hold never refuses or shows itself. While a
// hold covers a draft's author or a file's writer, triggers copy what a change or deletion would
// lose into `skill_draft_history` / `skill_draft_file_history`, and the change goes through as
// usual (purges included). The copies are immutable, readable under break-glass only, kept while
// a hold covers their author or writer, and purged by the retention pass once none does.

/** Mirrors `SKILL_NAME` in the server's skills/skill-md.ts. */
const NAME_FORMAT = "^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$";
/** All files of one draft together (SK11). */
export const SKILL_DRAFT_MAX_BYTES = 5 * 1024 * 1024;
/** Mirrors the upload's `maxFiles`. */
export const SKILL_DRAFT_MAX_FILES = 200;
/** Mirrors the upload's `maxPathBytes` (and the package contract's 240-byte paths). */
const PATH_MAX_BYTES = 240;
/** A fork's parent reference is a few ids and a hash. */
const PARENT_REF_MAX_BYTES = 4096;

/** How a draft was started (SK10); `blank` is a bare SKILL.md skeleton. */
export const SKILL_DRAFT_STARTS = ["blank", "template", "thread", "fork", "upload", "git"] as const;
export type SkillDraftStart = (typeof SKILL_DRAFT_STARTS)[number];

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const ts = () => timestamp({ withTimezone: true });

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * Team table: one draft. `rev` rises by one on every change to the draft or its files (the
 * server's compare-and-set: a stale `If-Match` is refused with who changed it, `updated_by`).
 * `size_bytes` and `file_count` follow the files (a trigger; the check caps them).
 *
 * Provenance never changes (a trigger): `started_from`, `parent_ref` (the forked version: a fork
 * has one, nothing else does) and `from_thread_id` (the team conversation a `thread` draft was
 * started from; no key, so a purged thread doesn't clear it; whoever writes it checks the thread is
 * in the draft's team). `co_edited` turns true, for good, once anyone but the author changes the
 * draft (a trigger). Both decide whether the author may save it as a personal skill (SK11).
 * `owner_departed_at`: when the offboarding sweep found the author no longer an active member;
 * cleared if they return, the draft purged 30 days after it.
 */
export const skillDrafts = pgTable(
  "skill_drafts",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    // Users are deactivated, never deleted (NO ACTION); offboarding purges a departed author's drafts.
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    /** Shared with the team's Builders and Team admins (co-edit); private when false. */
    shared: boolean().notNull().default(false),
    /** The skill name: the SKILL.md frontmatter `name` once it parses, else as created. */
    name: text().notNull(),
    startedFrom: text().$type<SkillDraftStart>().notNull().default("blank"),
    parentRef: jsonb().$type<Record<string, unknown>>(),
    fromThreadId: uuid(),
    coEdited: boolean().notNull().default(false),
    /**
     * The revision the last save from its conversation wrote (Save to Workbench, KOBE-322;
     * `save_skill_draft`, KOBE-442); null once the conversation no longer saves into it. The
     * agent's tool updates the draft only while `rev` still equals it and the draft is private.
     */
    syncedRev: integer(),
    ownerDepartedAt: ts(),
    rev: integer().notNull().default(1),
    sizeBytes: integer().notNull().default(0),
    fileCount: integer().notNull().default(0),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
    updatedBy: uuid()
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    // (team_id, id): the files reference their draft with team_id included (KOBE-29 rule).
    primaryKey({ columns: [t.teamId, t.id] }),
    // The author's list, and offboarding.
    index("skill_drafts_owner_idx").on(t.teamId, t.ownerUserId, t.updatedAt),
    // The retention pass (drafts unchanged for longer than the team's window).
    index("skill_drafts_updated_idx").on(t.teamId, t.updatedAt),
    // One draft per skill name that a conversation saves into (KOBE-442 review H1): concurrent
    // saves from one conversation update one draft instead of making two.
    uniqueIndex("skill_drafts_thread_sync_uq")
      .on(t.teamId, t.ownerUserId, t.fromThreadId, t.name)
      .where(sql`${t.fromThreadId} IS NOT NULL AND ${t.syncedRev} IS NOT NULL`),
    check("skill_drafts_name_format", sql`${t.name} ~ ${sql.raw(`'${NAME_FORMAT}'`)}`),
    check("skill_drafts_started_from", sql`${t.startedFrom} IN (${list(SKILL_DRAFT_STARTS)})`),
    check(
      "skill_drafts_parent_ref",
      sql`${t.parentRef} IS NULL OR (jsonb_typeof(${t.parentRef}) = 'object' AND octet_length(${t.parentRef}::text) <= ${sql.raw(String(PARENT_REF_MAX_BYTES))})`,
    ),
    check(
      "skill_drafts_provenance",
      sql`(${t.startedFrom} = 'thread') = (${t.fromThreadId} IS NOT NULL) AND (${t.startedFrom} = 'fork') = (${t.parentRef} IS NOT NULL)`,
    ),
    check("skill_drafts_rev_positive", sql`${t.rev} > 0`),
    check(
      "skill_drafts_size",
      sql`${t.sizeBytes} BETWEEN 0 AND ${sql.raw(String(SKILL_DRAFT_MAX_BYTES))} AND ${t.fileCount} BETWEEN 0 AND ${sql.raw(String(SKILL_DRAFT_MAX_FILES))}`,
    ),
  ],
);

/**
 * Team table: one file of a draft, by its package path. Exactly one of `text_content` (valid
 * UTF-8 without NUL, stored inline) and `bytes` (anything else) is set; `size` is its byte length.
 * `updated_by` wrote the current content (a hold on them keeps it when it is overwritten).
 */
export const skillDraftFiles = pgTable(
  "skill_draft_files",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    draftId: uuid().notNull(),
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
    primaryKey({ columns: [t.teamId, t.draftId, t.path] }),
    foreignKey({
      name: "skill_draft_files_draft_fk",
      columns: [t.teamId, t.draftId],
      foreignColumns: [skillDrafts.teamId, skillDrafts.id],
    }).onDelete("cascade"),
    // A held writer's files (break-glass user grants, hold checks).
    index("skill_draft_files_writer_idx").on(t.teamId, t.updatedBy),
    check(
      "skill_draft_files_path_size",
      sql`octet_length(${t.path}) BETWEEN 1 AND ${sql.raw(String(PATH_MAX_BYTES))}`,
    ),
    check("skill_draft_files_one_content", sql`(${t.textContent} IS NULL) <> (${t.bytes} IS NULL)`),
    check(
      "skill_draft_files_size",
      sql`${t.size} = COALESCE(octet_length(${t.textContent}), octet_length(${t.bytes})) AND ${t.size} <= ${sql.raw(String(SKILL_DRAFT_MAX_BYTES))}`,
    ),
  ],
);

/** What a hold kept: a draft changed (`changed`: renamed or re-shared) or deleted. */
export const SKILL_DRAFT_HISTORY_CHANGES = ["changed", "deleted"] as const;
/** What a hold kept: a file's content overwritten or the file deleted. */
export const SKILL_DRAFT_FILE_HISTORY_CHANGES = ["overwritten", "deleted"] as const;

/**
 * Team table: a legal hold's copy of a draft row as it was before a rename, a sharing change or
 * its deletion (written by the drafts' triggers only while a hold covers the author or the last
 * writer). Immutable; deleting it is refused while such a hold lasts. No keys to the draft: it
 * outlives it.
 */
export const skillDraftHistory = pgTable(
  "skill_draft_history",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    draftId: uuid().notNull(),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    updatedBy: uuid()
      .notNull()
      .references(() => users.id),
    name: text().notNull(),
    shared: boolean().notNull(),
    startedFrom: text().$type<SkillDraftStart>().notNull(),
    parentRef: jsonb().$type<Record<string, unknown>>(),
    fromThreadId: uuid(),
    rev: integer().notNull(),
    change: text().$type<(typeof SKILL_DRAFT_HISTORY_CHANGES)[number]>().notNull(),
    draftCreatedAt: ts().notNull(),
    draftUpdatedAt: ts().notNull(),
    keptAt: ts().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    index("skill_draft_history_owner_idx").on(t.teamId, t.ownerUserId),
    index("skill_draft_history_writer_idx").on(t.teamId, t.updatedBy),
    check("skill_draft_history_change", sql`${t.change} IN (${list(SKILL_DRAFT_HISTORY_CHANGES)})`),
  ],
);

/**
 * Team table: a legal hold's copy of a draft file's content before it was overwritten or deleted
 * (written by the triggers only while a hold covers the draft's author or the content's writer).
 * Immutable; deleting it is refused while such a hold lasts.
 */
export const skillDraftFileHistory = pgTable(
  "skill_draft_file_history",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    draftId: uuid().notNull(),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    writtenBy: uuid()
      .notNull()
      .references(() => users.id),
    path: text().notNull(),
    textContent: text(),
    bytes: bytea(),
    size: integer().notNull(),
    change: text().$type<(typeof SKILL_DRAFT_FILE_HISTORY_CHANGES)[number]>().notNull(),
    writtenAt: ts().notNull(),
    keptAt: ts().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    index("skill_draft_file_history_owner_idx").on(t.teamId, t.ownerUserId),
    index("skill_draft_file_history_writer_idx").on(t.teamId, t.writtenBy),
    check(
      "skill_draft_file_history_change",
      sql`${t.change} IN (${list(SKILL_DRAFT_FILE_HISTORY_CHANGES)})`,
    ),
    check(
      "skill_draft_file_history_one_content",
      sql`(${t.textContent} IS NULL) <> (${t.bytes} IS NULL)`,
    ),
  ],
);
