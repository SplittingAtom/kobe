"use client";

import { useEffect, useState } from "react";
import { listSkills } from "../../lib/admin/api/team/skills";
import type { ApiError } from "../../lib/api/client";
import { savedSkillsOf, type SavedSkillRuns } from "../../lib/skills/eval-history";
import { listSkillEvals } from "../../lib/skills/evals-api";

export interface SavedSkillRunsState {
  readonly saved: readonly SavedSkillRuns[];
  readonly error: ApiError | null;
}

const NONE: SavedSkillRunsState = { saved: [], error: null };

/**
 * The eval runs of the skill this draft was saved as (KOBE-459, `lib/skills/eval-history.ts`):
 * read while `active` (the Eval tab is shown), again each time it is shown or `refresh` changes
 * (a version was just saved). Only the newest read counts.
 */
export function useSavedSkillRuns({
  teamId,
  name,
  mine,
  active,
  refresh,
}: {
  readonly teamId: string;
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
      const reads = await Promise.all(skills.map((s) => listSkillEvals(teamId, s.scope, s.id)));
      if (!current) return;
      const failed = reads.find((r) => !r.ok);
      setState({
        saved: skills.flatMap((skill, i) => {
          const read = reads[i];
          return read?.ok ? [{ skill, runs: read.data }] : [];
        }),
        error: failed && !failed.ok ? failed.error : null,
      });
    })();
    return () => {
      current = false;
    };
  }, [teamId, name, mine, active, refresh]);
  return state;
}
