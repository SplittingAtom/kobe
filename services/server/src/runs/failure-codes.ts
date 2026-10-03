import type { ErrorInfo } from "@kobe/protocol";

/**
 * `run.failed` codes the server writes itself, each with the server's own message: text from a
 * sandbox is untrusted and is never shown to the user (only logged). Unknown codes become
 * `start_failed` (a start) or `model_error` (a model call, KOBE-41).
 */
export const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  account_inactive: "The run could not start: the account is deactivated or no longer in the team.",
  agent_unavailable: "The run could not start: the thread's agent version is not available.",
  timeout: "Your workspace did not answer in time, so the run could not start.",
  thread_not_found: "The run could not start: the thread is not available to the workspace.",
  start_lost: "The run could not start: the server that started it stopped. Send it again.",
  start_failed: "The run could not start in your workspace.",
  pi_rejected: "Your workspace refused the message (Pi could not take the prompt).",
  pi_unavailable: "Your workspace could not start Pi.",
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
};

/**
 * The `run.failed` error for a code, with the server's text; a code without a message of its own
 * keeps the code (the client may know it) and gets the fallback's text.
 */
export function failureInfo(code: string, fallback: "start_failed" | "model_error"): ErrorInfo {
  return { code, message: FAILURE_MESSAGES[code] ?? FAILURE_MESSAGES[fallback] ?? "" };
}
