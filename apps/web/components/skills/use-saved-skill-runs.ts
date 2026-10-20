"use client";

import { useEffect, useState } from "react";
import { listSkills, listSkillVersions, type SkillSummary } from "../../lib/admin/api/team/skills";
import type { ApiError } from "../../lib/api/client";
import { savedSkillsOf, type SavedSkillRuns } from "../../lib/skills/eval-history";
import type { ApiResult } from "../../lib/api/client";
import { listSkillEvals } from "../../lib/skills/evals-api";

export interface SavedSkillRunsState {
  readonly saved: readonly SavedSkillRuns[];
  readonly error: ApiError | null;
}

const NONE: SavedSkillRunsState = { saved: [], error: null };

/** One matched skill: the versions the viewer saved and, if any, the skill's runs. */
async function readSaved(
  teamId: string,
  skill: SkillSummary,
  viewerId: string,
): Promise<ApiResult<SavedSkillRuns | null>> {
  const listed = await listSkillVersions(teamId, skill.id);
  if (!listed.ok) return listed;
  const versions = listed.data.filter((v) => v.uploadedBy === viewerId);
  if (versions.length === 0) return { ...listed, data: null };
  const runs = await listSkillEvals(teamId, skill.scope, skill.id);
  if (!runs.ok) return runs;
  return { ...runs, data: { skill, runs: runs.data, versions } };
}

/**
 * The eval runs of the skill this draft was saved as (KOBE-459, `lib/skills/eval-history.ts`):
 * read while `active` (the Eval tab is shown), again each time it is shown or `refresh` changes
 * (a version was just saved). Only versions `viewerId` saved count;
 * only the newest read counts.
 */
export function useSavedSkillRuns({
  teamId,
  viewerId,
  name,
  mine,
  active,
  refresh,
}: {
  readonly teamId: string;
  readonly viewerId: string;
  /** The skill name a save uses: SKILL.md's, else the draft's. */
  readonly name: string;
  readonly mine: boolean;
  readonly active: boolean;
  readonly refresh: number;
}): SavedSkillRunsState {
  const [state, setState] = useState<SavedSkillRunsState>(NONE);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void (async () => {
      const listed = await listSkills(teamId);
      if (!listed.ok) {
        if (current) setState({ saved: [], error: listed.error });
        return;
      }
      const skills = savedSkillsOf(listed.data, name, mine);
      const reads = await Promise.all(skills.map((s) => readSaved(teamId, s, viewerId)));
      if (!current) return;
      const failed = reads.find((r) => !r.ok);
      setState({
        saved: reads.flatMap((r) => (r.ok && r.data ? [r.data] : [])),
        error: failed && !failed.ok ? failed.error : null,
      });
    })();
    return () => {
      current = false;
    };
  }, [teamId, viewerId, name, mine, active, refresh]);
  return state;
}
