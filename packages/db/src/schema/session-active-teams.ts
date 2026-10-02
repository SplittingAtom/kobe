import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { sessions } from "./auth.js";
import { teams } from "./teams.js";

/**
 * Install-wide. The active team of one sign-in session (spec D9): a pointer, no team content.
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
