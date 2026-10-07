import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { runs } from "./runs.js";
import { teams } from "./teams.js";

// Run-bound model-gateway tokens (KOBE-118, part of KOBE-73). One row per minted token: the
// server inserts it with the run's `run.start` lease and revokes it when the run ends; the
// model-gateway checks it on every call carrying `x-kobe-run-token` (the MAC proves the server
// minted the token, this row proves it is still wanted). The token itself is never stored, only
// its `jti`. Several rows may exist per run (a re-delivered `run.start` mints a new one).
export const runTokens = pgTable(
  "run_tokens",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    jti: text().notNull(),
    runId: uuid().notNull(),
    sandboxId: uuid().notNull(),
    issuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.jti] }),
    foreignKey({
      name: "run_tokens_run_fk",
      columns: [t.teamId, t.runId],
      foreignColumns: [runs.teamId, runs.id],
    }).onDelete("cascade"),
    check("run_tokens_jti_len", sql`char_length(${t.jti}) BETWEEN 16 AND 128`),
    index("run_tokens_run_idx").on(t.teamId, t.runId),
  ],
);
