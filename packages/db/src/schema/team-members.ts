import { pgEnum, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

export const teamRole = pgEnum("team_role", ["team_admin", "builder", "member"]);

/** Team table: membership and team role (authorization arrives in KOBE-14). */
export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: teamRole().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);
