import { z } from "zod";
import {
  approvalResolutionCauseSchema,
  approvalStatusSchema,
  idSchema,
  policyReasonSchema,
  riskClassSchema,
  timestampSchema,
  uuidSchema,
} from "@kobe/protocol";
import type { ApprovalRow } from "./store.js";

/**
 * An approval as the API shows it to the run's user (`GET /v1/approvals…`, the `POST` answer):
 * the card's facts and the decision. Never the signed token or its MAC.
 */
export const approvalViewSchema = z.strictObject({
  approval_id: uuidSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
  tool: z.string(),
  /** The input exactly as it will run if allowed (the bytes the approval is signed over). */
  input: z.record(z.string(), z.unknown()),
  risk: riskClassSchema,
  reasons: z.array(policyReasonSchema),
  status: approvalStatusSchema,
  cause: approvalResolutionCauseSchema.nullable(),
  decided_by: uuidSchema.nullable(),
  decided_at: timestampSchema.nullable(),
  expires_at: timestampSchema,
  created_at: timestampSchema,
  remembered: z.boolean(),
});
export type ApprovalView = z.infer<typeof approvalViewSchema>;

export const approvalListSchema = z.strictObject({ approvals: z.array(approvalViewSchema) });

export const approvalListQuerySchema = z.strictObject({
  status: approvalStatusSchema.optional(),
  run_id: uuidSchema.optional(),
});

export function viewOf(row: ApprovalRow): ApprovalView {
  return {
    approval_id: row.id,
    run_id: row.runId,
    thread_id: row.threadId,
    tool_call_id: row.toolCallId,
    tool: row.tool,
    input: JSON.parse(row.inputCanonical) as Record<string, unknown>,
    risk: row.risk,
    reasons: [...row.reasons],
    status: row.status,
    cause: row.cause,
    decided_by: row.decidedBy,
    decided_at: row.decidedAt?.toISOString() ?? null,
    expires_at: row.expiresAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    remembered: row.remembered,
  };
}
