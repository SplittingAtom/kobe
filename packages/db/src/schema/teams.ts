import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Site-wide. A team's slug names its sandbox namespace `kobe-team-<slug>` (≤ 63 chars). */
export const teams = pgTable(
  "teams",
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /**
     * The Site's Registry team (KOBE-330 review, coordinator decision): a dedicated team Kobe
     * creates for the Registry, set at creation and never changed (trigger, 0160). Only such a
     * team can be the Registry team, so the Skill reviewer grant never adds anyone to an
     * ordinary team. At most one.
     */
    registry: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("teams_slug_format", sql`${t.slug} ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'`),
    uniqueIndex("teams_registry_uq")
      .on(t.registry)
      .where(sql`${t.registry}`),
  ],
);
