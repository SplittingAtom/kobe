import { defineDomain } from "./types.js";

/** Workspace Features (KOBE-53–57). */
export const workspace = defineDomain({
  team: [
    "artifacts",
    "artifact_versions",
    "files",
    "team_storage_quotas",
    "memory_docs",
    "memory_doc_versions",
    "team_memory_settings",
  ],
  installWide: [],
  grants: {},
  teamReferencing: {},
});
