import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { sessions, users } from "./auth.js";
import { teams } from "./teams.js";

/**
 * Site-wide. The active team of one sign-in session (spec D9): a pointer, no team content.
 * Kept out of Better Auth's `sessions` so its `update-session` endpoint can never set it; the row
 * goes away with the session. Membership is re-checked on every team-scoped request.
 */
export const sessionActiveTeams = pgTable("session_active_teams", {
  sessionId: uuid()
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  teamId: uuid()
    .notNull()
    .references(() => teams.id),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Site-wide. The team each user last made active (KOBE-456): a pointer, no team content. A new
 * sign-in session starts in it while the user is still a member (checked on read), so it follows
 * the user across browsers. Written whenever a session's active team is set.
 */
export const userLastTeams = pgTable("user_last_teams", {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  teamId: uuid()
    .notNull()
    .references(() => teams.id),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
