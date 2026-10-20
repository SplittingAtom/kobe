import { foreignKey, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { connectors } from "./connectors.js";
import { teams } from "./teams.js";
import { threads } from "./threads.js";

/**
 * Connectors the owner turned off for one conversation (KOBE-451, the composer's + menu): a row
 * means "off in this thread"; no row means on, so a new thread starts with every usable connector
 * on and a fork starts fresh. The run start leaves an off connector out of `run.start.mcp`. Team
 * table: the key includes `team_id`, rows follow their thread (cascade) and their connector.
 * A setting, not conversation content: no legal-hold guard (a held thread is never purged, so its
 * rows stay with it anyway).
 */
export const threadConnectorsOff = pgTable(
  "thread_connectors_off",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    threadId: uuid().notNull(),
    connectorId: uuid()
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    turnedOffBy: uuid().references(() => users.id, { onDelete: "set null" }),
    turnedOffAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.threadId, t.connectorId] }),
    foreignKey({
      name: "thread_connectors_off_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
  ],
);
