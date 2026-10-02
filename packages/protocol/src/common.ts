import { z } from "zod";
import { findJsonSafetyIssue } from "./json-safety.js";

/**
 * Shared primitives for every Kobe contract. Wire format is JSON with snake_case keys (spec §6.2).
 */

/** Any JSON value (what `JSON.parse` can return). Tool inputs, Pi payloads, entry payloads. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.json();

/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

/**
 * A tool input as it crosses a boundary (sandbox → server, server → browser, approval signing).
 * A JSON object with the json-safety.ts rules applied: no U+0000, no `__proto__` keys, no unsafe
 * integers. The input that executes must be exactly `JSON.parse(canonicalJson(input))` of the
 * input that was decided and signed (see approval.ts).
 */
export const toolInputSchema: z.ZodType<JsonObject> = z
  .unknown()
  .superRefine((value, ctx) => {
    // Checked on the raw value: z.record would turn a `__proto__` key into a prototype.
    const issue = findJsonSafetyIssue(value, { rejectUnsafeIntegers: true });
    if (issue !== undefined) ctx.addIssue({ code: "custom", message: `tool input: ${issue}` });
  })
  .pipe(jsonObjectSchema);

/**
 * Opaque identifier for ids Kobe does not mint: Pi entry ids (usually 8-char hex, may fall back to
 * a UUID; verified Pi 1.0.0), Pi tool-call ids, wire request/command ids. Non-empty, at most 128
 * chars (matches `thread_entries.entry_id`'s check), no control characters.
 */
// eslint-disable-next-line no-control-regex
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]+$/u;
export const idSchema = z.string().min(1).max(128).regex(NO_CONTROL_CHARS);

/**
 * Ids Kobe mints are Postgres `uuid`s (KOBE-29 schema): team, user, thread, run, approval, agent,
 * artifact, file, memory doc, project, connector, sandbox, tool rule. Lowercase canonical form.
 */
export const uuidSchema = z.uuid().regex(/^[0-9a-f-]+$/, "lowercase uuid");

/** RFC 3339 / ISO 8601 UTC timestamp, e.g. `2026-10-01T22:15:00Z` or with milliseconds. */
export const timestampSchema = z.iso.datetime({ offset: false });

/** Who is acting. Every server request carries exactly one `team_id` (D9). */
export const installRoleSchema = z.enum(["owner", "admin", "user"]);
export type InstallRole = z.infer<typeof installRoleSchema>;

export const teamRoleSchema = z.enum(["team_admin", "builder", "member"]);
export type TeamRole = z.infer<typeof teamRoleSchema>;

/** How a run was started (`runs.trigger`, spec §5.4). */
export const runTriggerSchema = z.enum(["user", "schedule"]);
export type RunTrigger = z.infer<typeof runTriggerSchema>;

/** Thread approval modes (D29). There is deliberately no bypass mode. */
export const APPROVAL_MODES = ["ask-on-write", "ask-all", "auto"] as const;
export const approvalModeSchema = z.enum(APPROVAL_MODES);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;

/**
 * Risk class of a tool call, derived from MCP annotations (D29): `readOnlyHint: true` → `read`;
 * `destructiveHint: true` or missing hints → `destructive`; otherwise `write`. Unannotated tools
 * count as destructive + open-world (see `riskFromAnnotations` in policy.ts).
 */
export const riskClassSchema = z.enum(["read", "write", "destructive"]);
export type RiskClass = z.infer<typeof riskClassSchema>;

/** The verified caller of a server operation (derived from the session, never from the body). */
export interface ActorContext {
  readonly user_id: string;
  readonly team_id: string;
  readonly install_role: InstallRole;
  readonly team_role: TeamRole;
}

/** Usage of one model step or one run, as Pi reports it (verified: Pi 1.0.0 `Usage`). */
export const usageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cache_read: z.number().int().nonnegative(),
  cache_write: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
});
export type Usage = z.infer<typeof usageSchema>;

/** A machine-readable error: stable `code`, human `message`. `message` must not leak secrets. */
export const errorInfoSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(2000),
});
export type ErrorInfo = z.infer<typeof errorInfoSchema>;
