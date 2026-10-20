import { sql } from "drizzle-orm";
import { check, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
    /**
     * Who made the membership when Kobe did it (KOBE-331 review): `skill_reviewer_grant` = Kobe
     * added a Skill reviewer to the Registry team, and taking the grant removes it. Null = the
     * team's own member (an invitation, an admin's change, or a member before the grant); it never
     * goes from null back to the grant.
     */
    addedVia: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    check(
      "team_members_added_via",
      sql`${t.addedVia} IS NULL OR ${t.addedVia} = 'skill_reviewer_grant'`,
    ),
  ],
);
