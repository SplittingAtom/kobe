import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Install-wide. A team's slug names its sandbox namespace `kobe-team-<slug>` (≤ 63 chars). */
export const teams = pgTable(
  "teams",
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("teams_slug_format", sql`${t.slug} ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'`)],
);
