/**
 * The Workbench's Eval history (KOBE-459): this draft's eval runs and, once the draft has been
 * saved as a skill, that skill's version runs, in one list labelled by source, newest first.
 *
 * A draft keeps no link to the skill it was saved as: Save version files it under the skill of
 * SKILL.md's name in the chosen destination (the bump suggestion finds it the same way,
 * services/server `skills/drafts/suggest.ts`). So the saved skill is the same-named team skill
 * and, for the draft's author, their personal skill of that name (only the author can save a
 * draft as a personal skill).
 */
import type { SkillSummary } from "../admin/api/team/skills";
import { subjectLabel, type SkillEvalRun } from "./evals-api";

export const DRAFT_SOURCE = "This draft";

export interface SavedSkillRuns {
  readonly skill: SkillSummary;
  readonly runs: readonly SkillEvalRun[];
}

export interface HistoryRow {
  readonly run: SkillEvalRun;
  /** "This draft", "Team skill x", "Personal skill x". */
  readonly source: string;
  /** "revision 3", "v1.2.0" or "version 2". */
  readonly of: string;
}

/** The skills this draft has been saved as: same name; the personal one for its author only. */
export function savedSkillsOf(
  skills: readonly SkillSummary[],
  name: string,
  mine: boolean,
): SkillSummary[] {
  return skills.filter((s) => s.slug === name && (s.scope === "team" || mine));
}

const sourceOf = (skill: SkillSummary): string =>
  `${skill.scope === "team" ? "Team" : "Personal"} skill ${skill.slug}`;

function versionOf(skill: SkillSummary, run: SkillEvalRun): string {
  const { subject } = run;
  if (subject.kind !== "draft" && subject.seq === skill.latestVersion)
    return `v${skill.latestSemver}`;
  return subjectLabel(run);
}

/** One list, newest first; a run listed twice shows once. */
export function mergeEvalHistory(
  draftRuns: readonly SkillEvalRun[],
  saved: readonly SavedSkillRuns[],
): HistoryRow[] {
  const rows: HistoryRow[] = [
    ...draftRuns.map((run) => ({ run, source: DRAFT_SOURCE, of: subjectLabel(run) })),
    ...saved.flatMap(({ skill, runs }) =>
      runs.map((run) => ({ run, source: sourceOf(skill), of: versionOf(skill, run) })),
    ),
  ];
  return rows
    .filter((r, i) => rows.findIndex((o) => o.run.id === r.run.id) === i)
    .sort((a, b) => Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt));
}
