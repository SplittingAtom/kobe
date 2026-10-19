import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { threads } from "./threads.js";

/**
 * MCP Apps in the conversation (KOBE-438, spec MA10): the upstream's full result of a model call
 * to a tool that opens a pinned `ui://` template, as mcp-proxy captured it (never the sandbox).
 * Team table: every key includes `team_id`, and rows follow their thread (cascade, retention,
 * legal hold, fork). A result up to 256 KiB is `inline` (`result`), up to 4 MiB a `blob` in the
 * thread's own S3 tree (`blob_ref`, `BLOB_REF_COLUMNS`), larger or over the team's storage quota
 * `too_large` (no result kept; the card renders as text).
 *
 * The proxy cannot tell which of Pi's tool calls it serves, so a row is stored **unclaimed**
 * (`tool_call_id` NULL) under the run, Pi tool name and input digest the server's signed capture
 * ticket names, and the run's `tool.result` claims the oldest matching row and gets the `app`
 * marker. `entry_id` is for MA-6's app cards (a rail launch, no tool call).
 */
export const THREAD_APP_RESULT_STORAGE = ["inline", "blob", "too_large"] as const;
export type ThreadAppResultStorage = (typeof THREAD_APP_RESULT_STORAGE)[number];

/** Results up to this size are kept in Postgres; larger ones in S3 (spec MA10). */
export const APP_RESULT_INLINE_MAX_BYTES = 256 * 1024;
/** The proxy's own response cap: nothing larger is ever stored. */
export const APP_RESULT_MAX_BYTES = 4 * 1024 * 1024;

const HEX64 = "^[0-9a-f]{64}$";

export const threadAppResults = pgTable(
  "thread_app_results",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    threadId: uuid().notNull(),
    runId: uuid(),
    /** Pi's tool name (`mcp__<server>__<tool>`) and the canonical input digest of the call. */
    piName: text(),
    inputSha256: text(),
    /** Set when the run's `tool.result` claims the row. */
    toolCallId: text(),
    /**
     * The run's prompt entry (Pi entry id), set at the claim: tool call ids are unique per run
     * only, so (prompt entry, tool call) places the card in the tree, also in a fork (whose runs
     * are not copied) and after the run row is gone.
     */
    promptEntryId: text(),
    /** MA-6: an app card entry (a rail launch). */
    entryId: text(),
    connectorId: uuid().notNull(),
    /** The upstream tool name. */
    tool: text().notNull(),
    templateUri: text().notNull(),
    templateSha256: text().notNull(),
    appId: text().notNull(),
    storage: text().$type<ThreadAppResultStorage>().notNull(),
    result: jsonb().$type<Record<string, unknown>>(),
    blobRef: text(),
    /** UTF-8 bytes of the result as JSON (also when too large: the size that was refused). */
    bytes: bigint({ mode: "number" }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "thread_app_results_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    // The run key (team_id, run_id) → runs ON DELETE SET NULL (run_id) is in 0158 (custom SQL:
    // drizzle cannot name the column list). A fork's copies have no run.
    // One result per tool call of a run, and per placed tool call of a thread.
    unique("thread_app_results_tool_call").on(t.teamId, t.runId, t.toolCallId),
    unique("thread_app_results_placed").on(t.teamId, t.threadId, t.promptEntryId, t.toolCallId),
    unique("thread_app_results_entry").on(t.teamId, t.threadId, t.entryId),
    index("thread_app_results_thread_idx").on(t.teamId, t.threadId),
    // The claim: the oldest unclaimed row of a run, tool and input.
    index("thread_app_results_unclaimed_idx")
      .on(t.teamId, t.runId, t.piName, t.inputSha256, t.createdAt)
      .where(sql`${t.toolCallId} IS NULL AND ${t.entryId} IS NULL`),
    // Retention looks blob keys up by (team, key) (BLOB_REF_COLUMNS thread: true).
    index("thread_app_results_blob_ref_idx").on(t.teamId, t.blobRef),
    check("thread_app_results_storage", sql`${t.storage} IN ('inline', 'blob', 'too_large')`),
    check(
      "thread_app_results_stored",
      sql`(${t.storage} = 'inline') = (${t.result} IS NOT NULL)
        AND (${t.storage} = 'blob') = (${t.blobRef} IS NOT NULL)`,
    ),
    check("thread_app_results_bytes", sql`${t.bytes} >= 0`),
    check(
      "thread_app_results_inline_size",
      sql`${t.storage} <> 'inline' OR ${t.bytes} <= ${sql.raw(String(APP_RESULT_INLINE_MAX_BYTES))}`,
    ),
    // An app card (entry) or a model call: unclaimed under (run, tool, input), claimed under its
    // tool call; never both.
    check(
      "thread_app_results_origin",
      sql`NOT (${t.entryId} IS NOT NULL AND ${t.toolCallId} IS NOT NULL)
        AND (${t.entryId} IS NOT NULL OR ${t.toolCallId} IS NOT NULL
          OR (${t.runId} IS NOT NULL AND ${t.piName} IS NOT NULL AND ${t.inputSha256} IS NOT NULL))`,
    ),
    check(
      "thread_app_results_hashes",
      sql`${t.templateSha256} ~ '${sql.raw(HEX64)}' AND ${t.appId} ~ '${sql.raw(HEX64)}'
        AND (${t.inputSha256} IS NULL OR ${t.inputSha256} ~ '${sql.raw(HEX64)}')`,
    ),
    check("thread_app_results_uri", sql`${t.templateUri} LIKE 'ui://%'`),
  ],
);
