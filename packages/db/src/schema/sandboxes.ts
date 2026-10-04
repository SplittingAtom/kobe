import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Sandbox lifecycle (KOBE-25, spec D11, D14, §5.4). Kubernetes is the record of what exists
// (KOBE-22: claims, Sandboxes, pods); this row is the record of what Kobe decided — awake or
// hibernated — and of the last activity the idle policy measures. Every activity touch and every
// hibernate/wake decision takes this row's lock, which orders hibernation against wake across
// replicas (docs/ledger/KOBE-25.md).

export const sandboxState = pgEnum("sandbox_state", [
  "running", // awake (or being woken): may hold a connection
  "hibernated", // agent-sandbox `operatingMode: Suspended`: no pod, volume kept, /tmp wiped
  "destroyed", // offboarded (KOBE-28): volume retained until `retain_until`
]);
export type SandboxState = (typeof sandboxState.enumValues)[number];

/** One row per (team, user) sandbox (D11). */
export const sandboxes = pgTable(
  "sandboxes",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** agent-sandbox claim UID (KOBE-22 sandbox id, session token `sub`); null until claimed. */
    sandboxId: uuid(),
    state: sandboxState().notNull().default("running"),
    /** The `/workspace` PersistentVolumeClaim (`workspace-u-<user>`), once known. */
    pvc: text(),
    /** Last activity (command routed, wake, run end): D14 hibernates 15 minutes after it. */
    lastActiveAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    stateChangedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Offboarding (KOBE-28): the volume is deleted after this. */
    retainUntil: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    // The hibernation sweep: awake sandboxes of a team, oldest activity first.
    index("sandboxes_awake_idx")
      .on(t.teamId, t.lastActiveAt)
      .where(sql`${t.state} = 'running'`),
    check("sandboxes_pvc", sql`${t.pvc} IS NULL OR char_length(${t.pvc}) BETWEEN 1 AND 253`),
    check("sandboxes_retain_until", sql`${t.retainUntil} IS NULL OR ${t.state} = 'destroyed'`),
  ],
);
