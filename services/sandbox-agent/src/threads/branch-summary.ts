import type { ThreadBranchSummaryFrame, ThreadBranchSummaryResultFrame } from "@kobe/protocol";
import { PiProcessError } from "../pi/pi-process.js";
import {
  BRANCH_SUMMARY_COMMAND,
  type BranchSummaryOutcome,
  type BranchSummaryRequest,
} from "../kobe-models/branch-summary-protocol.js";

type ResultOk = Extract<ThreadBranchSummaryResultFrame, { ok: true }>;
type ResultErr = Extract<ThreadBranchSummaryResultFrame, { ok: false }>;

/** What `thread.branch_summary` answers, before the agent adds `command_id` and `thread_id`. */
export type BranchSummaryReply =
  | Omit<ResultOk, "v" | "type" | "command_id" | "thread_id">
  | Omit<ResultErr, "v" | "type" | "command_id" | "thread_id">;

export type BranchSummaryErrorCode = ResultErr["error"]["code"];

/** Wire failures carry the agent's own short text, never Pi's (Pi's text stays in the agent's log). */
const FIXED: Record<BranchSummaryErrorCode, string> = {
  thread_busy: "the thread is busy",
  nothing_to_summarize: "the branch left has no message",
  summary_failed: "the branch summary failed",
  model_not_configured: "no model to summarize with",
  pi_unavailable: "Pi is not available",
  internal: "internal error in the sandbox agent",
  runtime_tampered: "Pi's runtime changed; Pi was stopped",
};

export const branchSummaryFailure = (code: BranchSummaryErrorCode): BranchSummaryReply => ({
  ok: false,
  error: { code, message: FIXED[code] },
});

/** The armed request for kobe-models (ids and focus only; never the prompt's text). */
export const branchSummaryRequestOf = (frame: ThreadBranchSummaryFrame): BranchSummaryRequest => ({
  from: frame.from_leaf_entry_id,
  to: frame.to_entry_id,
  ...(frame.focus === undefined ? {} : { focus: frame.focus }),
});

/** The bare prompt that runs the command; its request comes over the armed dialog. */
export const branchSummaryPrompt = () => ({
  type: "prompt",
  message: `/${BRANCH_SUMMARY_COMMAND}`,
});

/** kobe-models' outcome as the wire reply (undefined: the command reported none). */
export function branchSummaryReplyOf(
  outcome: BranchSummaryOutcome | undefined,
): BranchSummaryReply {
  if (outcome === undefined) return branchSummaryFailure("summary_failed");
  if (outcome.ok) return { ok: true, entry_id: outcome.entry_id, parent_id: outcome.parent_id };
  return branchSummaryFailure(outcome.code);
}

/** A thrown error while summarising (Pi gone, timed out) as a wire failure. */
export function branchSummaryThrown(error: unknown): BranchSummaryReply {
  if (error instanceof PiProcessError) return branchSummaryFailure("pi_unavailable");
  return branchSummaryFailure("internal");
}
