import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teamRole } from "./team-members.js";
import { teams } from "./teams.js";

/**
 * Install-wide (spec §5.4 †, D7). An install admin's invitation of one email address into the
 * install. Only a SHA-256 hash of the single-use token is stored; the token itself exists only in
 * the email. Accepted and revoked rows are kept (they are the record of who let whom in).
 */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Lower-cased. */
    email: text().notNull(),
    /** Hex SHA-256 of the token; rotated on resend. */
    tokenHash: text().notNull().unique(),
    // Users are deactivated, never deleted; NO ACTION keeps the record intact.
    invitedBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    acceptedUserId: uuid().references(() => users.id),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // At most one open invitation per address; a new invite for it rotates that row's token.
    uniqueIndex("invitations_open_email")
      .on(t.email)
      .where(sql`${t.acceptedAt} IS NULL AND ${t.revokedAt} IS NULL`),
  ],
);

/**
 * Team table (KOBE-13). A team admin's invitation of an email address into the team with a role.
 * The person joins only by accepting it while signed in as that (verified) address, so team admins
 * can't add anyone without consent; the invite is answered the same way whether or not the address
 * belongs to a Kobe user. Rows are deleted when accepted, declined or revoked.
 */
export const teamInvitations = pgTable(
  "team_invitations",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    /** Lower-cased. */
    email: text().notNull(),
    role: teamRole().notNull(),
    invitedBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    unique("team_invitations_team_email").on(t.teamId, t.email),
    index("team_invitations_team_expires_idx").on(t.teamId, t.expiresAt),
  ],
);
