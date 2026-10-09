import type { TeamTable } from "../tenancy.js";

/**
 * Team tables with a `break_glass_read` SELECT policy (spec D10): the team content an install
 * admin may read under an active grant. Every other team table has only the canonical team policy.
 * Adding team content (files, memory, artifacts) means adding its table here and a policy in a
 * migration; the catalog check and the probe suite follow this list.
 */
export const BREAK_GLASS_READABLE_TABLES = [
  "threads",
  "thread_entries",
  "artifacts",
  "artifact_versions",
  "files",
] as const satisfies readonly TeamTable[];

export type BreakGlassReadableTable = (typeof BREAK_GLASS_READABLE_TABLES)[number];
