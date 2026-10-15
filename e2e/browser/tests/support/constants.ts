/** Where the setup project saves the signed-in session (gitignored). */
export const STORAGE_STATE = ".auth/user.json";

/** A real model run, including a sandbox waking up: generous on purpose. */
export const RUN_TIMEOUT_MS = 5 * 60_000;

/** How long a run may take to show up after a send before the wait gives up on seeing it start. */
export const RUN_START_TIMEOUT_MS = 90_000;

/** The chat shell after navigation (a cold page load against a remote deployment). */
export const SHELL_TIMEOUT_MS = 45_000;

/** The note under a sent message while its run has not ended (KOBE-288: never after the end). */
export const WAITING_FOR_AGENT = "Sent, waiting for the agent";
