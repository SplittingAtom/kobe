import { z } from "zod";
import { timestampSchema, uuidSchema } from "../common.js";

/**
 * Who curates semantic memory, how agents use it, and the names later tickets register
 * (KOBE-377). Contract only: the tables, migrations and checks are the named tickets'.
 */

// ----------------------------------------------------------------------------- stewards

/**
 * Site steward grant (KOBE-380): a `site_grants` value beside `skill_reviewer`. KOBE-380's
 * migration adds it to the `site_grant` enum and to `SITE_GRANTS` (skill-catalog.ts), which a
 * server test keeps equal to the enum; until then it is named here only. Given and taken through
 * the existing `PUT/DELETE /v1/site/roles/grants/{userId}/memory_steward`.
 */
export const MEMORY_STEWARD_SITE_GRANT = "memory_steward";

/**
 * In the wire scope vocabulary: `team` = a Workspace steward (KOBE-380's team table); `site` = the
 * Site grant.
 */
export const MEMORY_STEWARD_LEVELS = ["team", "site"] as const;
export const memoryStewardLevelSchema = z.enum(MEMORY_STEWARD_LEVELS);

/**
 * One steward. Stewardship is a grant over any Workspace role (Contributor included), given and
 * taken by Team admins (Workspace) or Site admins (Site); curators = Team admins + stewards.
 */
export const memoryStewardSchema = z.strictObject({
  user_id: uuidSchema,
  name: z.string().min(1).max(200),
  granted_by: uuidSchema,
  granted_at: timestampSchema,
});
export type MemorySteward = z.infer<typeof memoryStewardSchema>;

/**
 * - `GET    /v1/team/memory/stewards` -> `{ level: "team", stewards }` (Team admins)
 * - `PUT    /v1/team/memory/stewards/{userId}` -> {@link memoryStewardSchema} (a Workspace member)
 * - `DELETE /v1/team/memory/stewards/{userId}` -> 204
 * - `GET    /v1/site/memory/stewards` -> `{ level: "site", stewards }` (Site admins)
 */
export const memoryStewardListSchema = z.strictObject({
  level: memoryStewardLevelSchema,
  stewards: z.array(memoryStewardSchema).max(1000),
});
export type MemoryStewardList = z.infer<typeof memoryStewardListSchema>;

// ----------------------------------------------------------------------------- agent versions

/**
 * Memory setting of an agent version (KOBE-646, Q3): `all` (Notes and semantic memory),
 * `notes_only` (file memory only: no `run.start.memory.semantic`), `off` (no `run.start.memory`
 * and no memory tools). It is the runner's memory, never the agent owner's; agents are not a
 * scope. Evals and test chats get no memory whatever the setting.
 */
export const AGENT_MEMORY_SETTINGS = ["all", "notes_only", "off"] as const;
export const agentMemorySettingSchema = z.enum(AGENT_MEMORY_SETTINGS);
export type AgentMemorySetting = z.infer<typeof agentMemorySettingSchema>;

/** The field an agent version gains (KOBE-646); absent (older versions) decodes as `all`. */
export const agentVersionMemoryFieldSchema = z.object({
  memory: agentMemorySettingSchema.default("all"),
});

// ----------------------------------------------------------------------------- names

/**
 * Notification kinds of semantic memory. KOBE-645's migration adds them to the `notifications`
 * kind CHECK (packages/db `NOTIFICATION_KINDS`) and to `NOTIFICATION_KINDS` (notifications.ts) with their
 * payload rules, all at once so later phases need no migration of their own. Kinds by phase:
 */
export const MEMORY_NOTIFICATION_KINDS = [
  // Phase A (KOBE-645): curators' notices and the review reminder/digest.
  /** A shared scope reached 80% of its item cap (SM22); to its curators. */
  "memory.scope.near_full",
  /** Candidates wait in the person's To review section (reminder). */
  "memory.review.reminder",
  /** Curators' periodic digest of what changed in shared memory. */
  "memory.review.digest",
  // Phase B: Workspace proposals (KOBE-397) and readers' Suggest to editors (KOBE-652).
  "memory.proposal.received",
  "memory.proposal.accepted",
  "memory.proposal.dismissed",
  "memory.suggestion.received",
  "memory.suggestion.accepted",
  "memory.suggestion.dismissed",
  // Phase C: Site proposals (KOBE-403).
  "memory.site_proposal.received",
  "memory.site_proposal.accepted",
  "memory.site_proposal.dismissed",
] as const;
export type MemoryNotificationKind = (typeof MEMORY_NOTIFICATION_KINDS)[number];

/**
 * Audit actions reserved for Phase B and C (learning passes, candidates, Workspace and Site
 * proposals, readers' suggestions); their tickets register them with their metadata in
 * packages/db `AUDIT_EVENTS`. The Phase A memory item actions are registered there now.
 */
export const RESERVED_MEMORY_AUDIT_ACTIONS = [
  "memory.pass.started",
  "memory.pass.completed",
  "memory.pass.failed",
  "memory.candidate.accepted",
  "memory.candidate.dismissed",
  "memory.proposal.created",
  "memory.proposal.accepted",
  "memory.proposal.dismissed",
  "memory.suggestion.created",
  "memory.suggestion.accepted",
  "memory.suggestion.dismissed",
  "memory.site_proposal.created",
  "memory.site_proposal.accepted",
  "memory.site_proposal.dismissed",
] as const;
