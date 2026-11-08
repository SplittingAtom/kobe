import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Agent rosters (KOBE-565, spec agents-roster AR3/AR5/AR7): a roster entry is a reference to a
// personal agent in `site_agents` with a version rule, never a definition (ids and timestamps
// only, as `team_agent_suspensions`). Team-owned and gallery agents are implicit members of their
// roster and have no row. No foreign key to `site_agents`, like `team_agent_suspensions`: the
// server refuses to delete a rostered agent (409 agent_rostered), and a row for a deleted agent is
// inert. A removed entry keeps its row for the audit trail and can be re-assigned.

/** Roster entry states: proposed (awaiting an admin), active, removed (kept), suspended. */
export const AGENT_ROSTER_STATES = ["proposed", "active", "removed", "suspended"] as const;
export type AgentRosterState = (typeof AGENT_ROSTER_STATES)[number];

/** Follow the agent's latest published version, or a pinned one (`pinned_version`). */
export const AGENT_ROSTER_VERSION_RULES = ["latest", "pinned"] as const;
export type AgentRosterVersionRule = (typeof AGENT_ROSTER_VERSION_RULES)[number];

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/** The columns both rosters share: state, version rule and actors. */
const entryColumns = () => ({
  siteAgentId: uuid().notNull(),
  state: text().$type<AgentRosterState>().notNull().default("active"),
  versionRule: text().$type<AgentRosterVersionRule>().notNull().default("latest"),
  pinnedVersion: integer(),
  // Users are deactivated, never deleted (NO ACTION).
  assignedBy: uuid()
    .notNull()
    .references(() => users.id),
  assignedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** Who approved or declined a proposal, or last changed the entry as an admin. */
  decidedBy: uuid().references(() => users.id),
  decidedAt: timestamp({ withTimezone: true }),
  note: text(),
  removedAt: timestamp({ withTimezone: true }),
});

type EntryTable = Record<"state" | "versionRule" | "pinnedVersion" | "decidedBy" | "decidedAt", AnyPgColumn>;

const entryChecks = (name: string, t: EntryTable) => [
  check(`${name}_state`, sql`${t.state} IN (${list(AGENT_ROSTER_STATES)})`),
  check(`${name}_version_rule`, sql`${t.versionRule} IN (${list(AGENT_ROSTER_VERSION_RULES)})`),
  check(
    `${name}_pinned_version`,
    sql`(${t.versionRule} = 'pinned') = (${t.pinnedVersion} IS NOT NULL) AND (${t.pinnedVersion} IS NULL OR ${t.pinnedVersion} > 0)`,
  ),
  check(`${name}_decided`, sql`(${t.decidedBy} IS NULL) = (${t.decidedAt} IS NULL)`),
  // `removed_at` is deliberately not tied to `state`: an entry re-assigned after removal (AR7)
  // may keep it as history.
];

/** Personal agents assigned (or proposed) to a team's roster. Team table: RLS, FORCE. */
export const teamAgentRoster = pgTable(
  "team_agent_roster",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    ...entryColumns(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.siteAgentId] }),
    // The "Reach" column and owner-leaves checks look an agent up across rosters.
    index("team_agent_roster_agent_idx").on(t.siteAgentId),
    ...entryChecks("team_agent_roster", t),
  ],
);

/** Personal agents assigned (or proposed) to the site roster. Site-wide: no team data. */
export const siteAgentRoster = pgTable(
  "site_agent_roster",
  {
    ...entryColumns(),
  },
  (t) => [primaryKey({ columns: [t.siteAgentId] }), ...entryChecks("site_agent_roster", t)],
);
