import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { check } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Team-level suspension of agents the team does not own (KOBE-86, spec D19): a member's personal
// agent that is used in the team, or a gallery agent. Those agents live install-wide
// (`install_agents`), so their own `status` can't be a team's decision (it would reach other
// teams); a row here suspends the agent in this team only. Team agents keep using
// `team_agents.status`. No foreign key to `install_agents`: the agent is install-wide data and a
// suspension is not worth blocking its deletion; a row for a deleted agent is inert.

/** Scopes a team can suspend through this table. */
export const SUSPENDABLE_INSTALL_SCOPES = ["personal", "gallery"] as const;
export type SuspendableInstallScope = (typeof SUSPENDABLE_INSTALL_SCOPES)[number];

export const teamAgentSuspensions = pgTable(
  "team_agent_suspensions",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    agentScope: text().$type<SuspendableInstallScope>().notNull(),
    // Users are never deleted (NO ACTION).
    suspendedBy: uuid()
      .notNull()
      .references(() => users.id),
    suspendedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.agentId] }),
    index("team_agent_suspensions_agent_idx").on(t.agentId),
    check("team_agent_suspensions_scope", sql`${t.agentScope} IN ('personal', 'gallery')`),
  ],
);
