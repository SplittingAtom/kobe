import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { installAgentVersions, installAgents } from "./agents.js";

/**
 * Published Orbit scores of gallery agent versions (KOBE-94). Install-wide (†): gallery agents
 * belong to no team, so their scores can't live in the team table `orbit_evals`. An install admin
 * runs the eval in a team of theirs (an `orbit_evals` row there is the execution record); the
 * verdict is copied here. Append only; the newest row of a version is its score.
 */
export const galleryAgentScores = pgTable(
  "gallery_agent_scores",
  {
    id: uuid().primaryKey().defaultRandom(),
    agentId: uuid()
      .notNull()
      .references(() => installAgents.id),
    version: integer().notNull(),
    status: text().$type<"passed" | "blocked">().notNull(),
    attackSuccessRate: doublePrecision().notNull(),
    attempts: integer().notNull(),
    attackSuccesses: integer().notNull(),
    /** The ceiling the verdict was judged against. */
    threshold: doublePrecision().notNull(),
    /** The image's result.json. Contains no team data (scenario ids and counts). */
    report: jsonb().$type<Record<string, unknown>>(),
    evaluatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "gallery_agent_scores_version_fk",
      columns: [t.agentId, t.version],
      foreignColumns: [installAgentVersions.agentId, installAgentVersions.version],
    }),
    index("gallery_agent_scores_agent_idx").on(t.agentId, t.version, t.evaluatedAt.desc()),
    check("gallery_agent_scores_status", sql`${t.status} IN ('passed', 'blocked')`),
    check(
      "gallery_agent_scores_rate",
      sql`${t.attackSuccessRate} >= 0 AND ${t.attackSuccessRate} <= 1 AND ${t.threshold} >= 0 AND ${t.threshold} <= 1`,
    ),
  ],
);
