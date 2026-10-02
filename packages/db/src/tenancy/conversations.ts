import { defineDomain } from "./types.js";

/** Conversations, Runs & Streaming (KOBE-29–34). */
export const conversations = defineDomain({
  team: ["threads", "thread_entries", "runs", "run_events", "events"],
  installWide: [],
  grants: {},
  teamReferencing: {},
});
