/**
 * What kobe-sandbox-agent and the kobe-models extension share for a branch summary (KOBE-548,
 * docs/specs/conversation-tree.md CT11; spike KOBE-541). Self-contained like protocol.ts: the
 * extension ships on its own.
 *
 * The agent triggers the extension command with a bare `/kobe-branch-summary` prompt. Member
 * prompts reach Pi verbatim (spike note 1), so the command takes nothing from its arguments: the
 * handler asks the agent for the request over Pi's RPC dialog channel
 * ({@link BRANCH_SUMMARY_REQUEST_UI_TITLE}, answered by the agent from memory and never relayed, as
 * the run token is). The agent answers only while it has armed one, once, and cancels otherwise, so
 * a member typing the command gets a refusal and no summary. The handler reports its outcome on a
 * second dialog ({@link BRANCH_SUMMARY_RESULT_UI_TITLE}, the outcome as JSON in its placeholder),
 * which the agent takes only while it waits for it.
 */
export const BRANCH_SUMMARY_COMMAND = "kobe-branch-summary";
export const BRANCH_SUMMARY_REQUEST_UI_TITLE = "kobe.branch_summary";
export const BRANCH_SUMMARY_RESULT_UI_TITLE = "kobe.branch_summary_result";

/** Pi entry ids as the wire allows them (`idSchema`: 1-128 chars, no whitespace). */
const ENTRY_ID = /^[^\s]{1,128}$/;
const FOCUS_MAX_CHARS = 1000;
const DETAIL_MAX_CHARS = 2000;

export interface BranchSummaryRequest {
  readonly from: string;
  readonly to: string;
  readonly focus?: string;
}

export const BRANCH_SUMMARY_OUTCOME_CODES = [
  "nothing_to_summarize",
  "summary_failed",
  "model_not_configured",
  "thread_busy",
] as const;
export type BranchSummaryOutcomeCode = (typeof BRANCH_SUMMARY_OUTCOME_CODES)[number];

export type BranchSummaryOutcome =
  | { readonly ok: true; readonly entry_id: string; readonly parent_id: string }
  | { readonly ok: false; readonly code: BranchSummaryOutcomeCode; readonly detail: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && ENTRY_ID.test(v);

function parseJson(text: unknown): unknown {
  if (typeof text !== "string" || text.length > 16 * 1024) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The armed request as the agent answers it; undefined on anything but the exact shape. */
export function parseBranchSummaryRequest(text: unknown): BranchSummaryRequest | undefined {
  const raw = parseJson(text);
  if (!isRecord(raw) || !isId(raw.from) || !isId(raw.to)) return undefined;
  const keys = Object.keys(raw);
  if (keys.some((k) => k !== "from" && k !== "to" && k !== "focus")) return undefined;
  const focus = raw.focus;
  if (focus === undefined) return { from: raw.from, to: raw.to };
  if (typeof focus !== "string" || focus.length === 0 || focus.length > FOCUS_MAX_CHARS) {
    return undefined;
  }
  return { from: raw.from, to: raw.to, focus };
}

/** The handler's outcome as the extension reports it; undefined on anything but the exact shape. */
export function parseBranchSummaryOutcome(text: unknown): BranchSummaryOutcome | undefined {
  const raw = parseJson(text);
  if (!isRecord(raw)) return undefined;
  if (raw.ok === true) {
    return isId(raw.entry_id) && isId(raw.parent_id)
      ? { ok: true, entry_id: raw.entry_id, parent_id: raw.parent_id }
      : undefined;
  }
  if (
    raw.ok !== false ||
    typeof raw.code !== "string" ||
    !(BRANCH_SUMMARY_OUTCOME_CODES as readonly string[]).includes(raw.code)
  ) {
    return undefined;
  }
  const detail = typeof raw.detail === "string" ? raw.detail.slice(0, DETAIL_MAX_CHARS) : "";
  return { ok: false, code: raw.code as BranchSummaryOutcomeCode, detail };
}

export const branchSummaryFailure = (
  code: BranchSummaryOutcomeCode,
  detail: string,
): BranchSummaryOutcome => ({ ok: false, code, detail: detail.slice(0, DETAIL_MAX_CHARS) });
