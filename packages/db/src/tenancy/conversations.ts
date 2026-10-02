import { defineDomain } from "./types.js";

/** Conversations, Runs & Streaming (KOBE-29–34). */
export const conversations = defineDomain({
  team: [],
  installWide: [],
  grants: {},
  teamReferencing: {},
});
