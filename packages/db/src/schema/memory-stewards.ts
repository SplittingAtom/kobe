import { foreignKey, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teamMembers } from "./team-members.js";
import { teams } from "./teams.js";

/**
 * Team table (KOBE-380, v1.3 Semantic Memory SM19): Workspace memory stewards. Stewardship is a
 * grant on top of any Workspace role (Contributor or Member included), given and taken by Team
 * admins and audited by the server (`memory.steward.granted/revoked`). Curators of Workspace
 * memory = Team admins + these stewards. The grantee must be a member: the row goes with the
 * membership (composite FK, cascade). Site stewards are the `memory_steward` site grant.
 */
export const memoryStewards = pgTable(
  "memory_stewards",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid().notNull(),
    // Users are deactivated, never deleted (NO ACTION).
    grantedBy: uuid()
      .notNull()
      .references(() => users.id),
    grantedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    foreignKey({
      name: "memory_stewards_member_fk",
      columns: [t.teamId, t.userId],
      foreignColumns: [teamMembers.teamId, teamMembers.userId],
    }).onDelete("cascade"),
  ],
);
