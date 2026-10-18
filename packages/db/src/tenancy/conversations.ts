import { defineDomain } from "./types.js";

/** Conversations, Runs & Streaming (KOBE-29–34), answer feedback (KOBE-275). */
export const conversations = defineDomain({
  team: [
    "threads",
    "thread_entries",
    "runs",
    "run_events",
    "events",
    "answer_feedback",
    "answer_feedback_history",
  ],
  siteWide: [],
  grants: {},
  teamReferencing: {},
});
