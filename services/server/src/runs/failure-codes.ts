import type { ErrorInfo } from "@kobe/protocol";

/**
 * `run.failed` codes the server writes itself, each with the server's own message: text from a
 * sandbox is untrusted and is never shown to the user (only logged). Unknown codes become
 * `start_failed` (a start) or `model_error` (a model call, KOBE-41).
 */
export const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  account_inactive: "The run could not start: the account is deactivated or no longer in the team.",
  agent_unavailable: "The run could not start: the thread's agent version is not available.",
  agent_suspended:
    "This agent is suspended, so it can't start new runs. Ask your team admin to reactivate it, or start a conversation with another agent.",
  timeout: "Your workspace did not answer in time, so the run could not start.",
  thread_not_found: "The run could not start: the thread is not available to the workspace.",
  start_lost: "The run could not start: the server that started it stopped. Send it again.",
  start_failed: "The run could not start in your workspace.",
  pi_rejected: "Your workspace refused the message (Pi could not take the prompt).",
  pi_unavailable: "Your workspace could not start Pi.",
  // KOBE-41: the agent's pinned model is not enabled for the team (user decision: fail, never
  // fall back); `agentModelNotEnabled(alias)` names the alias.
  agent_model_not_enabled:
    "This agent's model isn't enabled for your team. Ask your team admin to enable it.",
  // KOBE-41: the model gateway's answers, as kobe-models reports them (`parseKobeModelError`).
  model_not_configured:
    "No model is enabled for your team yet. Ask a team admin to enable one in the team's model settings.",
  model_not_enabled:
    "That model is not enabled for your team. Ask a team admin to enable it, or use the team's default model.",
  model_session_revoked:
    "Your workspace's model access was revoked. Reload the page and try again.",
  model_throttled: "The model is rate-limited right now. Wait a moment and try again.",
  model_unavailable: "The model gateway is unavailable right now. Try again in a moment.",
  model_error: "The model returned an error. Try again, or pick another model.",
  // KOBE-42: the gateway refused a model call because a budget is used up.
  model_budget_exhausted:
    "The model budget is used up, so the model call was refused. Ask your team admin about the budget.",
  runtime_tampered:
    "Another process in your workspace changed Pi's private runtime directory, so the run was stopped. Check what is running in your workspace and try again.",
};

/** The `agent_model_not_enabled` error naming the alias (catalog-validated; capped anyway). */
export function agentModelNotEnabled(alias: string): ErrorInfo {
  return {
    code: "agent_model_not_enabled",
    message: `This agent's model (${alias.slice(0, 128)}) isn't enabled for your team. Ask your team admin to enable it.`,
  };
}

/**
 * The `run.failed` error for a code, with the server's text; a code without a message of its own
 * keeps the code (the client may know it) and gets the fallback's text.
 */
export function failureInfo(code: string, fallback: "start_failed" | "model_error"): ErrorInfo {
  return { code, message: FAILURE_MESSAGES[code] ?? FAILURE_MESSAGES[fallback] ?? "" };
}

/**
 * `agent_model_not_enabled` for a model chosen in the thread (KOBE-44): the same code as an
 * agent's pin (the client and the runbook know it), worded for the person who chose it.
 */
export function threadModelNotEnabled(alias: string): ErrorInfo {
  return {
    code: "agent_model_not_enabled",
    message: `The model chosen for this conversation (${alias.slice(0, 128)}) isn't enabled for your team any more. Pick another model, or ask your team admin to enable it.`,
  };
}
