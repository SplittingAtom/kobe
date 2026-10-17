import { z } from "zod";
import {
  argPatternSchema,
  REMEMBER_SCOPE_LABELS,
  REMEMBER_SCOPES,
  rememberScopeSchema,
  timestampSchema,
  uuidSchema,
  type ActorContext,
  type JsonObject,
  type ToolDescriptor,
} from "@kobe/protocol";
import { eq, users, withTeam } from "@kobe/db";
import { rememberRefusal } from "../policy/remember.js";
import { readTeamRememberLimits } from "../policy/remember-limits-store.js";
import {
  exactArgPattern,
  exactPinsAllArguments,
  rememberExpiry,
  usableTimeZone,
} from "../policy/remember-scope.js";
import { batchable } from "./approve-all.js";
import { ApprovalError, type ApprovalContext } from "./context.js";
import { listApprovals, loadApproval } from "./store.js";

/**
 * What the approval card may offer for one pending approval (`GET /v1/approvals/{id}/remember`,
 * KOBE-289), worked out by the server from its own state, never the client's: the remember scopes
 * the team's limits allow for this tool, each with the expiry the server would set now (in the
 * member's stored time zone), the "only this exact action" pattern derived from the stored
 * canonical input, and whether "Approve all waiting" is offered for the run. The decision
 * endpoints check all of it again.
 */
export const rememberOptionsViewSchema = z.strictObject({
  approval_id: uuidSchema,
  run_id: uuidSchema,
  /** False when nothing may be remembered for this call; `reason` says why. */
  can_remember: z.boolean(),
  reason: z.string().nullable(),
  choices: z.array(
    z.strictObject({
      scope: rememberScopeSchema,
      label: z.string(),
      /** When a rule made now would expire; null = with its thread or run, or when revoked. */
      expires_at: timestampSchema.nullable(),
    }),
  ),
  /** The time zone "until end of today" uses (the member's stored one, else UTC). */
  time_zone: z.string(),
  /** "Only this exact action": the pattern the rule would hold, or null if none fits. */
  exact: z
    .strictObject({
      arg_pattern: argPatternSchema,
      /** True: every argument is pinned (no other may be added); false: only the path is. */
      pins_all: z.boolean(),
    })
    .nullable(),
  /** The team allows only exact actions to be remembered. */
  exact_only: z.boolean(),
  /** Every waiting approval of this run "Approve all waiting" would allow; null = not offered. */
  approve_all: z.strictObject({ approval_ids: z.array(uuidSchema) }).nullable(),
  approve_all_reason: z.string().nullable(),
});
export type RememberOptionsView = z.infer<typeof rememberOptionsViewSchema>;

function cannotRemember(tool: ToolDescriptor | undefined): string | null {
  if (tool === undefined) return "This tool can't be remembered.";
  if (tool.risk === "destructive") return "Tools that can delete data are never remembered.";
  return null;
}

export async function rememberOptions(
  ctx: ApprovalContext,
  actor: ActorContext,
  approvalId: string,
): Promise<RememberOptionsView> {
  const teamId = actor.team_id;
  const loaded = await withTeam(ctx.db, teamId, async (tx) => {
    const row = await loadApproval(tx, teamId, approvalId);
    if (row?.userId !== actor.user_id) return undefined;
    const waiting =
      row.status === "pending"
        ? await listApprovals(tx, teamId, actor.user_id, {
            status: "pending",
            runId: row.runId,
            limit: 100,
          })
        : [];
    const [user] = await tx
      .select({ timeZone: users.timeZone })
      .from(users)
      .where(eq(users.id, actor.user_id));
    const limits = (await readTeamRememberLimits(tx, teamId)).effective;
    return { row, waiting, timeZone: user?.timeZone ?? null, limits };
  });
  if (!loaded) throw new ApprovalError("approval_not_found", 404, "No approval with that id.");
  const { row, waiting, timeZone, limits } = loaded;
  const now = ctx.now();
  const tool = await ctx.registry.resolve(teamId, row.tool);
  const pending = row.status === "pending" && now < row.expiresAt;

  const blocked = cannotRemember(tool) ?? (pending ? null : "This approval is no longer waiting.");
  const choices =
    blocked !== null || tool === undefined
      ? []
      : REMEMBER_SCOPES.filter(
          (scope) => rememberRefusal(scope, true, { tool }, limits) === undefined,
        ).map((scope) => {
          const expires = rememberExpiry(scope, now, timeZone, limits.max_duration_seconds);
          return {
            scope,
            label: REMEMBER_SCOPE_LABELS[scope],
            expires_at: expires?.toISOString() ?? null,
          };
        });
  const pattern =
    tool === undefined
      ? undefined
      : exactArgPattern(tool, JSON.parse(row.inputCanonical) as JsonObject);
  const canRemember =
    choices.length > 0 && (!limits.exact_only || pattern !== undefined) && blocked === null;

  const others = waiting.filter((w) => now < w.expiresAt);
  const tools = new Map<string, ToolDescriptor | undefined>();
  for (const w of others) {
    if (!tools.has(w.tool)) tools.set(w.tool, await ctx.registry.resolve(teamId, w.tool));
  }
  let approveAllReason: string | null = null;
  if (others.length < 2) approveAllReason = "Only one approval is waiting in this run.";
  else if (!limits.approve_all)
    approveAllReason = "Your team doesn't allow approving several at once.";
  else if (others.some((w) => !batchable(w, tools.get(w.tool)))) {
    approveAllReason = "Some waiting calls can delete data or reach outside Kobe; decide each one.";
  }

  return {
    approval_id: row.id,
    run_id: row.runId,
    can_remember: canRemember,
    reason: canRemember
      ? null
      : (blocked ??
        (choices.length === 0
          ? "Your team doesn't allow remembering this approval."
          : "Your team allows only exact actions to be remembered, and this one can't be pinned.")),
    choices: canRemember ? choices : [],
    time_zone: usableTimeZone(timeZone),
    exact:
      pattern === undefined || tool === undefined
        ? null
        : { arg_pattern: pattern, pins_all: exactPinsAllArguments(tool) },
    exact_only: limits.exact_only,
    approve_all:
      approveAllReason === null ? { approval_ids: others.map((w) => w.id).sort() } : null,
    approve_all_reason: approveAllReason,
  };
}
