import { pgEnum, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

export const teamRole = pgEnum("team_role", ["team_admin", "builder", "member"]);

/**
 * Team table. `user_id` gains its foreign key to `users` with Better Auth (KOBE-12); roles and
 * authorization arrive in KOBE-14.
 */
export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid().notNull(),
    role: teamRole().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);
