/**
 * The Workbench's Eval history (KOBE-459): this draft's eval runs and, once the draft has been
 * saved as a skill, that skill's version runs, in one list labelled by source, newest first.
 *
 * A saved version keeps no link to the draft it came from (only the audit log names the draft;
 * a `draft_id` on versions would need a migration, a follow-up). Save version files a draft under
 * the skill of SKILL.md's name in the chosen destination (the bump suggestion finds it the same
 * way, services/server `skills/drafts/suggest.ts`). So the history matches by name, narrowly:
 * the same-named team skill and, for the draft's author, their personal skill of that name (only
 * the author can save a draft as a personal skill), and of those only the versions the viewer
 * saved. Those rows say "(same name)": the match is the name, not a recorded link.
 */
import type { SkillSummary } from "../admin/api/team/skills";
import { subjectLabel, type SkillEvalRun } from "./evals-api";

export const DRAFT_SOURCE = "This draft";

/** A version of the matched skill the viewer saved. */
export interface SavedVersion {
  readonly seq: number;
  readonly semver: string;
}

export interface SavedSkillRuns {
  readonly skill: SkillSummary;
  readonly runs: readonly SkillEvalRun[];
  /** The versions the viewer saved: only their runs are listed. */
  readonly versions: readonly SavedVersion[];
}

export interface HistoryRow {
  readonly run: SkillEvalRun;
  /** "This draft", "Team skill x (same name)", "Personal skill x (same name)". */
  readonly source: string;
  /** "revision 3" for the draft, "v1.2.0" for a saved version. */
  readonly of: string;
}

/** The skills this draft may have been saved as: same name; the personal one for its author. */
export function savedSkillsOf(
  skills: readonly SkillSummary[],
  name: string,
  mine: boolean,
): SkillSummary[] {
  return skills.filter((s) => s.slug === name && (s.scope === "team" || mine));
}

const sourceOf = (skill: SkillSummary): string =>
  `${skill.scope === "team" ? "Team" : "Personal"} skill ${skill.slug} (same name)`;

function savedRows({ skill, runs, versions }: SavedSkillRuns): HistoryRow[] {
  const semverOf = new Map(versions.map((v) => [v.seq, v.semver]));
  return runs.flatMap((run) => {
    const semver = run.subject.kind === "draft" ? undefined : semverOf.get(run.subject.seq);
    return semver === undefined ? [] : [{ run, source: sourceOf(skill), of: `v${semver}` }];
  });
}

/** One list, newest first; a run listed twice shows once. */
export function mergeEvalHistory(
  draftRuns: readonly SkillEvalRun[],
  saved: readonly SavedSkillRuns[],
): HistoryRow[] {
  const rows: HistoryRow[] = [
    ...draftRuns.map((run) => ({ run, source: DRAFT_SOURCE, of: subjectLabel(run) })),
    ...saved.flatMap(savedRows),
  ];
  return rows
    .filter((r, i) => rows.findIndex((o) => o.run.id === r.run.id) === i)
    .sort((a, b) => Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt));
}
