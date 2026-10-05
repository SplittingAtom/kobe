import { defineDomain } from "./types.js";

/** Workspace Features (KOBE-53–57). */
export const workspace = defineDomain({
  team: ["artifacts", "artifact_versions"],
  installWide: [],
  grants: {},
  teamReferencing: {},
});
