import { ALL_PRIVILEGES, defineDomain } from "./types.js";

/**
 * Semantic memory (v1.3, KOBE-376). Workspace items are team tables; portable and Site items are
 * site-wide, read with app-role grants and filtered by the server (no SECURITY DEFINER, KOBE-42).
 * File memory (`memory_docs`, the UI's Notes) stays in `workspace.ts`. Site stewards are the
 * `memory_steward` value of `site_grants` (identity).
 */
export const memory = defineDomain({
  team: [
    "semantic_memory_items",
    "semantic_memory_item_versions",
    "run_memory_items",
    // Run records for the site-wide lanes: the run belongs to the Workspace.
    "run_portable_memory_items",
    "run_site_memory_items",
    // Workspace memory stewards (KOBE-380): a grant on top of any Workspace role.
    "memory_stewards",
  ],
  siteWide: [
    "portable_memory_items",
    "portable_memory_item_versions",
    "site_memory_items",
    "site_memory_item_versions",
  ],
  grants: {
    // Portable preferences (like personal_skills): the server confines rows to their owner.
    portable_memory_items: ALL_PRIVILEGES,
    // Versions are immutable: append and read only (a trigger backs this up).
    portable_memory_item_versions: ["SELECT", "INSERT"],
    // Site items (like site_settings): read in every Workspace; the server writes them only for
    // Site admins and stewards. DELETE: a purge of a Site item (its versions go with it).
    site_memory_items: ALL_PRIVILEGES,
    site_memory_item_versions: ["SELECT", "INSERT"],
  },
  teamReferencing: {},
});
