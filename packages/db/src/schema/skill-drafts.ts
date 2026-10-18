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
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Workbench drafts (KOBE-320, spec SK10, SK11): a member's mutable working copy of a skill, owned
// by (author, team). Team tables: team_id NOT NULL, ENABLE + FORCE RLS with the canonical policy
// (custom migration `*_skill_drafts_rls.sql`). Private to the author unless shared with the team's
// Builders and Team admins (the server decides who reads and writes; RLS keeps teams apart). The
// whole draft lives in Postgres: text files inline, other files as bytea, at most
// SKILL_DRAFT_MAX_BYTES together. Drafts follow team retention (by last change) and offboarding.

/** Mirrors `SKILL_NAME` in the server's skills/skill-md.ts. */
const NAME_FORMAT = "^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$";
/** All files of one draft together (SK11). */
export const SKILL_DRAFT_MAX_BYTES = 5 * 1024 * 1024;
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
 * `size_bytes` and `file_count` are recomputed from the files on every file change, inside the
 * same transaction; the check caps the total. `from_thread_id` is the team conversation it was
 * started from, if any (no key: the thread may be purged first; the draft still counts as started
 * from a conversation when saved as a personal skill). `parent_ref` names a forked version.
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
    check("skill_drafts_name_format", sql`${t.name} ~ ${sql.raw(`'${NAME_FORMAT}'`)}`),
    check("skill_drafts_started_from", sql`${t.startedFrom} IN (${list(SKILL_DRAFT_STARTS)})`),
    check(
      "skill_drafts_parent_ref",
      sql`${t.parentRef} IS NULL OR (jsonb_typeof(${t.parentRef}) = 'object' AND octet_length(${t.parentRef}::text) <= ${sql.raw(String(PARENT_REF_MAX_BYTES))})`,
    ),
    check("skill_drafts_rev_positive", sql`${t.rev} > 0`),
    check(
      "skill_drafts_size",
      sql`${t.sizeBytes} BETWEEN 0 AND ${sql.raw(String(SKILL_DRAFT_MAX_BYTES))} AND ${t.fileCount} >= 0`,
    ),
  ],
);

/**
 * Team table: one file of a draft, by its package path. Exactly one of `text_content` (valid
 * UTF-8 without NUL, stored inline) and `bytes` (anything else) is set; `size` is its byte length.
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
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.draftId, t.path] }),
    foreignKey({
      name: "skill_draft_files_draft_fk",
      columns: [t.teamId, t.draftId],
      foreignColumns: [skillDrafts.teamId, skillDrafts.id],
    }).onDelete("cascade"),
    check(
      "skill_draft_files_path_size",
      sql`octet_length(${t.path}) BETWEEN 1 AND ${sql.raw(String(PATH_MAX_BYTES))}`,
    ),
    check(
      "skill_draft_files_one_content",
      sql`(${t.textContent} IS NULL) <> (${t.bytes} IS NULL)`,
    ),
    check(
      "skill_draft_files_size",
      sql`${t.size} = COALESCE(octet_length(${t.textContent}), octet_length(${t.bytes})) AND ${t.size} <= ${sql.raw(String(SKILL_DRAFT_MAX_BYTES))}`,
    ),
  ],
);
