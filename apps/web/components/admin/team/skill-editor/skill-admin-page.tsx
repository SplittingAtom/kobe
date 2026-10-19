"use client";

import Link from "next/link";
import { getSkill } from "../../../../lib/admin/api/team/skills";
import { Button, PageHeader } from "../../../ui/console";
import { useTeamAccess } from "../../console-context";
import { ResourceView } from "../../parts";
import { useResource } from "../../use-resource";
import { SkillEvalHistory } from "../../../skills/skill-eval-history";
import { SkillReachPanel } from "./skill-reach";

const WORKBENCH = "/me/skills?tab=workbench";

/**
 * A team skill in the Team console (KOBE-321): its admin view only (access mode, the agents it
 * reaches, usage) and its eval scorecards per saved version (KOBE-328). Skills are written in
 * the member's Workbench (spec SK9), not here.
 */
export function SkillAdminPage({ skillId }: { readonly skillId: string }) {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => getSkill(teamId, skillId));
  return (
    <ResourceView state={state} label="skill">
      {(skill) => (
        <>
          <PageHeader
            title={skill.slug}
            back={<Link href="/admin/team/skills">All skills</Link>}
            description={`${skill.description} Latest version: v${skill.latestSemver}.`}
            actions={
              <Button asChild>
                <Link href={WORKBENCH}>Open the Workbench</Link>
              </Button>
            }
          />
          {/* Keyed by the version: a new version may change the review state the panel shows. */}
          <SkillReachPanel key={skill.latestVersion} skill={skill} />
          <SkillEvalHistory
            teamId={teamId}
            scope="team"
            skillId={skill.id}
            semverOf={(seq) => (seq === skill.latestVersion ? skill.latestSemver : undefined)}
          />
        </>
      )}
    </ResourceView>
  );
}
