import { defineDomain } from "./types.js";

/** Agents, Skills, Gallery & Orbit (KOBE-45–52). */
export const agents = defineDomain({
  team: [],
  installWide: ["skill_blocklist"],
  grants: {},
  teamReferencing: {},
});
