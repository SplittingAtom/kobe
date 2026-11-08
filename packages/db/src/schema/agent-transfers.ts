import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { siteAgents } from "./agents.js";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Agent transfers (KOBE-568, spec agents-roster AR10): the owner of a personal agent offers it to
// another member of a team they share; the recipient accepts or declines, the owner may cancel.
// Ids and timestamps only. The row belongs to the team the offer was made in (RLS); at most one
// pending offer per agent site-wide. Decided rows are kept as history. The pending unique index
// spans teams (it is not behind RLS), so an offer while another team holds one fails with 23505:
// acceptable, because only the agent's owner can offer it and the server answers 409 (cancel the
// other offer first); it reveals nothing to anyone else.

export const AGENT_TRANSFER_STATES = ["pending", "accepted", "declined", "cancelled"] as const;
export type AgentTransferState = (typeof AGENT_TRANSFER_STATES)[number];

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/** Offers of a personal agent to another member of the team. Team table: RLS, FORCE. */
export const agentTransfers = pgTable(
  "agent_transfers",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    /** The personal agent offered; deleting it drops its offers. */
    siteAgentId: uuid()
      .notNull()
      .references(() => siteAgents.id, { onDelete: "cascade" }),
    // Users are deactivated, never deleted (NO ACTION).
    fromUserId: uuid()
      .notNull()
      .references(() => users.id),
    toUserId: uuid()
      .notNull()
      .references(() => users.id),
    state: text().$type<AgentTransferState>().notNull().default("pending"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    uniqueIndex("agent_transfers_one_pending")
      .on(t.siteAgentId)
      .where(sql`${t.state} = 'pending'`),
    // A member's incoming and outgoing offers in a team.
    index("agent_transfers_to_idx").on(t.teamId, t.toUserId),
    index("agent_transfers_from_idx").on(t.teamId, t.fromUserId),
    check("agent_transfers_state", sql`${t.state} IN (${list(AGENT_TRANSFER_STATES)})`),
    check("agent_transfers_decided", sql`(${t.state} = 'pending') = (${t.decidedAt} IS NULL)`),
    check("agent_transfers_parties", sql`${t.fromUserId} <> ${t.toUserId}`),
  ],
);
