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
  "memory_docs",
  "memory_doc_versions",
  "project_files",
  "answer_feedback",
  "answer_feedback_history",
  "agent_eval_cases",
  "agent_eval_case_history",
  // Workbench drafts and a hold's copies of them (KOBE-320): team grants, user grants by author or writer.
  "skill_drafts",
  "skill_draft_files",
  "skill_draft_history",
  "skill_draft_file_history",
  // Skill eval runs and their executions (KOBE-325): team grants, user grants by the starter.
  "skill_eval_runs",
  "skill_eval_results",
] as const satisfies readonly TeamTable[];

export type BreakGlassReadableTable = (typeof BREAK_GLASS_READABLE_TABLES)[number];
