import {
  APPROVAL_TTL_MS,
  PROPOSE_FILE_EDIT_TOOL,
  builtinToolDescriptor,
  workspaceToolPath,
  type PolicyDecision,
  type PolicyInput,
  type PolicyReason,
  type ToolDescriptor,
} from "@kobe/protocol";
import { checkAgentTools } from "./gates.js";
import { SANDBOX_CWD, canonicalPath } from "./tool-inputs.js";

/**
 * The viewed-file guard (KOBE-493, docs/file-editing.md gap 3): a member-protection rule, decided
 * by the server after the engine on every `policy.check`, in every approval mode (Dangerous and
 * remembered approvals included), like the agent's `tools.deny`.
 *
 * When the run carries a viewed file (`runs.viewing.path`, set at send, on Retry and on regenerate
 * from `viewing_from_entry`), Pi's `write` and `edit` whose target is that file never change it
 * directly:
 *
 * - the agent can propose instead (the sandbox announced `file_edits` and the agent's `tools.deny`
 *   leaves `propose_file_edit`): **deny**, with a tool error the model can act on;
 * - it cannot: **ask** the member (never allowed without asking), since a refusal pointing at a
 *   missing tool would help nobody; where nobody can be asked (`auto`, scheduled, skill eval) the
 *   caller's existing rules turn that into a deny. Such an approval is never remembered
 *   (`approvals/remember-options.ts`, `decide.ts`) nor approved in bulk (`approve-all.ts`).
 *
 * An engine deny stands as it is. Paths are compared as normalised strings: Pi's path resolved
 * against `/workspace` (absolute or relative, `./`, `../`, `//`, trailing slash), then made
 * workspace-relative; case-sensitive; symlinks and hard links are not followed, so another name
 * for the same file is not guarded. Not covered: `bash`, `powershell`, `run_python` (which can
 * also write a viewed `.ipynb` or `.py`) and any other tool that writes files. `propose_file_edit`
 * and `open_file` are unaffected.
 *
 * Reason code `viewed_file` (stage `site_deny` for the refusal, `ask_rule` for the ask). The wire
 * keeps reason codes open, so sandboxes that predate the code still decode it.
 */
export const VIEWED_FILE_REASON = "viewed_file";

/** Why a viewed-file approval offers no "remember" (and refuses one). */
export const VIEWED_FILE_NOT_REMEMBERED =
  "The user is viewing this file, so an approval to change it directly is never remembered.";

/** The approval was asked by this guard. */
export function isViewedFileAsk(reasons: readonly { readonly code: string }[]): boolean {
  return reasons.some((r) => r.code === VIEWED_FILE_REASON);
}

export const VIEWED_FILE_GUARDED_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

export interface ViewedFileGuard {
  /** The server's own descriptor of the called tool. */
  readonly tool: ToolDescriptor;
  /** The call's input as the sandbox sent it. */
  readonly input: unknown;
  /** The run's viewed file (workspace-relative), if any. */
  readonly viewedPath: string | undefined;
  /**
   * The model can call `propose_file_edit`: the sandbox announced `file_edits` and the agent's
   * `tools.deny` doesn't remove it.
   */
  readonly canPropose: boolean;
  readonly now: Date;
}

/**
 * Whether the model can propose a change to `viewedPath` instead: the sandbox announced
 * `file_edits` and the agent's `tools.deny` (or a non-empty `tools.allow`) leaves
 * `propose_file_edit` for that path.
 */
export function proposeAvailable(
  agent: PolicyInput["agent"],
  fileEdits: boolean,
  viewedPath: string,
): boolean {
  const tool = builtinToolDescriptor(PROPOSE_FILE_EDIT_TOOL);
  if (!fileEdits || tool === undefined) return false;
  return checkAgentTools(agent, tool, { path: `${SANDBOX_CWD}/${viewedPath}` }).length === 0;
}

/** The workspace-relative file a Pi `write`/`edit` targets; undefined for anything else. */
export function viewedFileTarget(tool: ToolDescriptor, input: unknown): string | undefined {
  if (tool.source !== "pi" || !VIEWED_FILE_GUARDED_TOOLS.has(tool.name)) return undefined;
  if (typeof input !== "object" || input === null) return undefined;
  const raw = (input as { path?: unknown }).path;
  if (typeof raw !== "string") return undefined;
  const absolute = canonicalPath(raw);
  return absolute === undefined ? undefined : workspaceToolPath(absolute);
}

function refusal(path: string): PolicyReason {
  return {
    code: VIEWED_FILE_REASON,
    stage: "site_deny",
    message: `The user is viewing ${path}. Propose the change with propose_file_edit instead; nothing was written.`,
  };
}

function askReason(path: string, tool: string): PolicyReason {
  return {
    code: VIEWED_FILE_REASON,
    stage: "ask_rule",
    message: `The user is viewing ${path}; ${tool} would change it directly instead of proposing the change.`,
  };
}

/** The decision with the guard applied: `decision` itself when the guard does not apply. */
export function guardViewedFile(decision: PolicyDecision, g: ViewedFileGuard): PolicyDecision {
  if (decision.effect === "deny" || g.viewedPath === undefined) return decision;
  const target = viewedFileTarget(g.tool, g.input);
  if (target === undefined || target !== g.viewedPath) return decision;
  if (g.canPropose) {
    return { effect: "deny", risk: decision.risk, reasons: [refusal(target)] };
  }
  const reason = askReason(target, g.tool.name);
  if (decision.effect === "require_approval") {
    return { ...decision, reasons: [reason, ...decision.reasons] };
  }
  return {
    effect: "require_approval",
    risk: decision.risk,
    reasons: [reason],
    expires_at: new Date(g.now.getTime() + APPROVAL_TTL_MS).toISOString(),
  };
}
