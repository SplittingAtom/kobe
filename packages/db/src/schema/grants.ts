import { pgEnum, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";

/** Grants beside the role ladder (KOBE-311, spec SK22); mirrors `SITE_GRANTS` (@kobe/protocol). */
export const siteGrant = pgEnum("site_grant", ["skill_reviewer"]);
export type SiteGrantKind = (typeof siteGrant.enumValues)[number];

/**
 * Site-wide (†): a user's site grants (SK22), the smallest step toward custom roles (D8). Given and
 * taken by the Owner or a Site admin (audited by the server); checked beside the role ladder.
 */
export const siteGrants = pgTable(
  "site_grants",
  {
    // Users are deactivated, never deleted (NO ACTION); a deactivated grantee's grant is inert.
    userId: uuid()
      .notNull()
      .references(() => users.id),
    grant: siteGrant().notNull(),
    grantedBy: uuid()
      .notNull()
      .references(() => users.id),
    grantedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.grant] })],
);
