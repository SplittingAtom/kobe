import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgEnum,
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

// Pending and decided tool-call approvals (spec D29, §5.4 `approvals`; KOBE-37). A team table:
// one row per (run, tool_call_id) that the policy engine sent to a human. The row is the record
// the approval card shows, the decision the sandbox waits for, and — once allowed — the signed
// token's state (`input_hmac`, `token_kid`, `token_expires_at`) that the MCP proxy verifies and
// consumes exactly once (`consumed_at`, `@kobe/protocol` approval.ts `ApprovalStore`).

/** `approvals.status` (spec §5.4; `approvalStatusSchema` in @kobe/protocol). */
export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "allowed",
  "denied",
  "expired",
]);
export type ApprovalStatusValue = (typeof approvalStatus.enumValues)[number];

/** Why an approval left `pending` (`APPROVAL_RESOLUTION_CAUSES` in @kobe/protocol). */
export const APPROVAL_CAUSES = [
  "user",
  "ttl",
  "run_cancelled",
  "run_interrupted",
  "budget_exhausted",
  "run_failed",
] as const;
export type ApprovalCause = (typeof APPROVAL_CAUSES)[number];

/** Largest canonical input stored (bytes); the server refuses larger ones before inserting. */
export const APPROVAL_INPUT_MAX_BYTES = 256 * 1024;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const approvals = pgTable(
  "approvals",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    runId: uuid().notNull(),
    threadId: uuid().notNull(),
    /** The run's user: the only person who may decide it (KOBE-37 decision, D8/D29). */
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** Pi's tool call id (`idSchema`), unique per run: a replayed id can't get a second approval. */
    toolCallId: text().notNull(),
    /** Tool name as Pi sees it (`mcp__jira__create_issue`). */
    tool: text().notNull(),
    /**
     * The tool input exactly as decided, as RFC 8785 canonical JSON (`canonicalJson`): the bytes the
     * HMAC covers. Kept as text, not jsonb, so the stored form can never drift from the signed one.
     */
    inputCanonical: text().notNull(),
    /** Risk class from the server's registry (never from the sandbox). */
    risk: text().notNull(),
    /** The policy reasons that required approval (`PolicyReason[]`), for the approval card. */
    reasons: jsonb().$type<unknown[]>().notNull(),
    status: approvalStatus().notNull().default("pending"),
    cause: text().$type<ApprovalCause>(),
    decidedBy: uuid().references(() => users.id),
    decidedAt: timestamp({ withTimezone: true }),
    /** Pending TTL (D29: 1 h); past it the call is denied and the run ends. */
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Signed token state, set when allowed (`approvalTokenSchema`: `kid`, `expires_at`, `mac`). */
    tokenKid: text(),
    tokenExpiresAt: timestamp({ withTimezone: true, precision: 3 }),
    inputHmac: text(),
    /** Set once by the enforcement point that executes the call (single use). */
    consumedAt: timestamp({ withTimezone: true }),
    /** A remember-rule (`tool_rules`) was written with the decision. */
    remembered: boolean().notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "approvals_run_fk",
      columns: [t.teamId, t.runId],
      foreignColumns: [runs.teamId, runs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "approvals_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    unique("approvals_tool_call_key").on(t.teamId, t.runId, t.toolCallId),
    // The expiry sweep and a user's pending approvals.
    index("approvals_pending_idx")
      .on(t.teamId, t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
    index("approvals_user_idx").on(t.teamId, t.userId, t.createdAt),
    check("approvals_tool_call_id", sql`char_length(${t.toolCallId}) BETWEEN 1 AND 128`),
    check("approvals_tool", sql`char_length(${t.tool}) BETWEEN 1 AND 256`),
    check(
      "approvals_input",
      sql`octet_length(${t.inputCanonical}) <= ${sql.raw(String(APPROVAL_INPUT_MAX_BYTES))}`,
    ),
    check("approvals_risk", sql`${t.risk} IN ('read', 'write', 'destructive')`),
    check("approvals_reasons", sql`jsonb_typeof(${t.reasons}) = 'array'`),
    check("approvals_cause", sql`${t.cause} IS NULL OR ${t.cause} IN (${list(APPROVAL_CAUSES)})`),
    // Pending ⇔ undecided; a decision always says why.
    check(
      "approvals_decided",
      sql`(${t.status} = 'pending') = (${t.decidedAt} IS NULL AND ${t.cause} IS NULL)`,
    ),
    // A human decision names the human; expiries name none.
    check(
      "approvals_decided_by",
      sql`(${t.status} IN ('allowed', 'denied')) = (${t.decidedBy} IS NOT NULL)`,
    ),
    // Only an allowed approval carries a signed token, and only it can be consumed.
    check(
      "approvals_token",
      sql`(${t.status} = 'allowed') = (${t.inputHmac} IS NOT NULL AND ${t.tokenKid} IS NOT NULL AND ${t.tokenExpiresAt} IS NOT NULL)`,
    ),
    check("approvals_consumed", sql`${t.consumedAt} IS NULL OR ${t.status} = 'allowed'`),
    check("approvals_mac", sql`${t.inputHmac} IS NULL OR ${t.inputHmac} ~ '^[A-Za-z0-9_-]{43}$'`),
  ],
);
