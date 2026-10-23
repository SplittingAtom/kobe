import {
  APPROVAL_TTL_MS,
  workspaceToolPath,
  type PolicyDecision,
  type PolicyReason,
  type ToolDescriptor,
} from "@kobe/protocol";
import { canonicalPath } from "./tool-inputs.js";

/**
 * The viewed-file guard (KOBE-493, docs/file-editing.md gap 3): a member-protection rule, decided
 * by the server after the engine on every `policy.check`, in every approval mode (Dangerous and
 * remembered approvals included), like the agent's `tools.deny`.
 *
 * When the run carries a viewed file (`runs.viewing.path`, set at send, on Retry and on regenerate
 * from `viewing_from_entry`), Pi's `write` and `edit` whose target is that file never change it
 * directly:
 *
 * - the sandbox announced `file_edits` (the model has `propose_file_edit`): **deny**, with a tool
 *   error the model can act on;
 * - it did not: **ask** the member (never allowed without asking); where nobody can be asked
 *   (`auto`, scheduled, skill eval) the caller's existing rules turn that into a deny.
 *
 * An engine deny stands as it is. Paths are compared as normalised strings: Pi's path resolved
 * against `/workspace` (absolute or relative, `./`, `../`, `//`, trailing slash), then made
 * workspace-relative; case-sensitive; symlinks are not followed. `bash`, `run_python` and other
 * tools that can write files are not covered; `propose_file_edit` and `open_file` are unaffected.
 *
 * Reason codes reuse `site_deny_rule` / `site_ask_rule` (no `rule_id`: a built-in rule) so the
 * protocol's reason list is unchanged.
 */
export const VIEWED_FILE_GUARDED_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

export interface ViewedFileGuard {
  /** The server's own descriptor of the called tool. */
  readonly tool: ToolDescriptor;
  /** The call's input as the sandbox sent it. */
  readonly input: unknown;
  /** The run's viewed file (workspace-relative), if any. */
  readonly viewedPath: string | undefined;
  /** The sandbox announced `file_edits` (it registers `propose_file_edit`). */
  readonly fileEdits: boolean;
  readonly now: Date;
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
    code: "site_deny_rule",
    stage: "site_deny",
    message: `The user is viewing ${path}. Propose the change with propose_file_edit instead; nothing was written.`,
  };
}

function askReason(path: string, tool: string): PolicyReason {
  return {
    code: "site_ask_rule",
    stage: "ask_rule",
    message: `The user is viewing ${path}; ${tool} would change it directly instead of proposing the change.`,
  };
}

/** The decision with the guard applied: `decision` itself when the guard does not apply. */
export function guardViewedFile(decision: PolicyDecision, g: ViewedFileGuard): PolicyDecision {
  if (decision.effect === "deny" || g.viewedPath === undefined) return decision;
  const target = viewedFileTarget(g.tool, g.input);
  if (target === undefined || target !== g.viewedPath) return decision;
  if (g.fileEdits) {
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
