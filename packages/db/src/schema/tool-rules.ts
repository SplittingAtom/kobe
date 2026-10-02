import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teamMembers } from "./team-members.js";
import { teams } from "./teams.js";

// Tool rules (spec D6, D29, §5.4). The spec's single `tool_rules(team_id?, scope, …)` is split in
// two so every team row sits behind team RLS: install rules (the policy floor) are install-wide;
// team and user rules are a team table. `arg_pattern` is `{ "<JSON Pointer>": "<glob>" }`
// (`argPatternSchema` in @kobe/protocol), never a regular expression; the server validates it.

/** deny | ask | allow. Install rules use deny and ask only; user rules use allow only. */
export const toolRuleEffect = pgEnum("tool_rule_effect", ["deny", "ask", "allow"]);
export type ToolRuleEffect = (typeof toolRuleEffect.enumValues)[number];

/** Scope of a row in `tool_rules` (install rules live in `install_tool_rules`). */
export const toolRuleScope = pgEnum("tool_rule_scope", ["team", "user"]);

const GLOB_LENGTH_CHECK = (column: unknown) => sql`char_length(${column}) BETWEEN 1 AND 256`;
const ARG_PATTERN_CHECK = (column: unknown) =>
  sql`${column} IS NULL OR jsonb_typeof(${column}) = 'object'`;

/** Install-wide (†): the install policy floor, managed by install Owner/Admins (D6, D8). */
export const installToolRules = pgTable(
  "install_tool_rules",
  {
    id: uuid().primaryKey().defaultRandom(),
    effect: toolRuleEffect().notNull(),
    toolGlob: text().notNull(),
    argPattern: jsonb().$type<Record<string, string>>(),
    note: text(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // The floor only tightens: install allow rules would loosen every team at once.
    check("install_tool_rules_effect", sql`${t.effect} IN ('deny', 'ask')`),
    check("install_tool_rules_glob", GLOB_LENGTH_CHECK(t.toolGlob)),
    check("install_tool_rules_arg_pattern", ARG_PATTERN_CHECK(t.argPattern)),
    check("install_tool_rules_note", sql`${t.note} IS NULL OR char_length(${t.note}) <= 500`),
  ],
);

/**
 * Team table: team rules (team admins, D6) and user rules ("approve and remember", D29; one user in
 * one team). A user rule goes away with the user's membership (cascade inside the same team).
 */
export const toolRules = pgTable(
  "tool_rules",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    scope: toolRuleScope().notNull(),
    /** The user a `user` rule belongs to; null for `team` rules (scope_ref = team_id). */
    userId: uuid(),
    effect: toolRuleEffect().notNull(),
    toolGlob: text().notNull(),
    argPattern: jsonb().$type<Record<string, string>>(),
    note: text(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "tool_rules_member_fk",
      columns: [t.teamId, t.userId],
      foreignColumns: [teamMembers.teamId, teamMembers.userId],
    }).onDelete("cascade"),
    // Rules the engine loads per decision: the team's rules plus one user's.
    index("tool_rules_scope_idx").on(t.teamId, t.scope, t.userId),
    check("tool_rules_scope_ref", sql`(${t.scope} = 'team') = (${t.userId} IS NULL)`),
    // Users only remember allow rules; deny/ask are team policy.
    check("tool_rules_user_effect", sql`${t.scope} = 'team' OR ${t.effect} = 'allow'`),
    check("tool_rules_glob", GLOB_LENGTH_CHECK(t.toolGlob)),
    check("tool_rules_arg_pattern", ARG_PATTERN_CHECK(t.argPattern)),
    check("tool_rules_note", sql`${t.note} IS NULL OR char_length(${t.note}) <= 500`),
  ],
);
