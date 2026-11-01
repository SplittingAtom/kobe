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
    // MCP Apps results of model calls (KOBE-438): they follow their thread.
    "thread_app_results",
    // The team's thread folders (KOBE-534, TF1); threads name theirs in folder_id.
    "thread_folders",
  ],
  siteWide: [],
  grants: {},
  teamReferencing: {},
});
