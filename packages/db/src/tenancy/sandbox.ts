import { defineDomain } from "./types.js";

/** Sandbox Runtime (KOBE-21–28). */
export const sandbox = defineDomain({
  team: [],
  installWide: [],
  grants: {},
  teamReferencing: {},
});
