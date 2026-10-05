import { sql } from "drizzle-orm";
import {
  bigint,
  check,
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
import { runs } from "./runs.js";
import { teams } from "./teams.js";
import { threads } from "./threads.js";

// Artifacts (KOBE-129 = 55c of KOBE-55, spec D25; design: docs/ledger/KOBE-55.md D-5). Team tables:
// every key and foreign key includes team_id, so a cascade can never reach another team's rows.
// Content lives in S3 (`artifact_versions.blob_ref`, listed in `blob-refs.ts`), never in Postgres.

/** Kinds an artifact can have (packages/protocol `ARTIFACT_KINDS`). */
export const ARTIFACT_KIND_VALUES = ["html", "svg", "markdown", "mermaid", "code", "csv"] as const;

const teamRef = () =>
  uuid()
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" });

/** One artifact of a thread; `current_version` is the newest row of `artifact_versions`. */
export const artifacts = pgTable(
  "artifacts",
  {
    teamId: teamRef(),
    id: uuid().notNull().defaultRandom(),
    threadId: uuid().notNull(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    kind: text().notNull(),
    title: text().notNull(),
    language: text(),
    currentVersion: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    // Target of the versions' composite foreign key: keeps their thread equal to the artifact's.
    unique("artifacts_team_id_thread").on(t.teamId, t.id, t.threadId),
    foreignKey({
      name: "artifacts_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    // The thread's artifact list, oldest first.
    index("artifacts_thread_idx").on(t.teamId, t.threadId, t.createdAt),
    check(
      "artifacts_kind",
      sql`${t.kind} IN ('html', 'svg', 'markdown', 'mermaid', 'code', 'csv')`,
    ),
    check("artifacts_title_length", sql`char_length(${t.title}) BETWEEN 1 AND 200`),
    check(
      "artifacts_language",
      sql`${t.language} IS NULL OR (${t.kind} = 'code' AND ${t.language} ~ '^[a-z0-9][a-z0-9+#.-]{0,31}$')`,
    ),
    check("artifacts_current_version", sql`${t.currentVersion} >= 1`),
  ],
);

/**
 * One immutable version. `thread_id` repeats the artifact's thread so retention can find the blob
 * keys of a purged thread (`BLOB_REF_COLUMNS` with `thread: true`); the composite foreign key to
 * the artifact keeps it equal. `(team_id, tool_call_id)` makes `artifact.put` idempotent: a
 * repeated call returns the first result.
 */
export const artifactVersions = pgTable(
  "artifact_versions",
  {
    teamId: teamRef(),
    artifactId: uuid().notNull(),
    version: integer().notNull(),
    threadId: uuid().notNull(),
    blobRef: text().notNull(),
    sizeBytes: bigint({ mode: "number" }).notNull(),
    sha256: text().notNull(),
    runId: uuid().notNull(),
    toolCallId: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.artifactId, t.version] }),
    unique("artifact_versions_artifact_version").on(t.artifactId, t.version),
    unique("artifact_versions_tool_call").on(t.teamId, t.toolCallId),
    foreignKey({
      name: "artifact_versions_artifact_fk",
      columns: [t.teamId, t.artifactId, t.threadId],
      foreignColumns: [artifacts.teamId, artifacts.id, artifacts.threadId],
    }).onDelete("cascade"),
    foreignKey({
      name: "artifact_versions_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "artifact_versions_run_fk",
      columns: [t.teamId, t.runId],
      foreignColumns: [runs.teamId, runs.id],
    }),
    // Retention looks blob keys up by (team, key) (BLOB_REF_COLUMNS thread: true).
    index("artifact_versions_blob_ref_idx").on(t.teamId, t.blobRef),
    index("artifact_versions_thread_idx").on(t.teamId, t.threadId),
    check("artifact_versions_version", sql`${t.version} >= 1`),
    check("artifact_versions_size", sql`${t.sizeBytes} >= 0`),
    check("artifact_versions_sha256", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);
