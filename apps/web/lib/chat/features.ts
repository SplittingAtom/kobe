/**
 * Branching from the root (editing the first message, regenerating the first answer): Chris chose
 * to support it, but it needs a protocol + sandbox-agent + server change (follow-up ticket). Until
 * the API exists the UI shows the actions disabled with this explanation; flip the flag and send
 * the root branch point from `kobe-runtime.tsx branchAndSend` when it lands.
 */
export const ROOT_BRANCHING_AVAILABLE = false;

export const ROOT_BRANCHING_PENDING =
  "Editing the first message is coming soon: the server can't start a new version from the beginning yet.";
