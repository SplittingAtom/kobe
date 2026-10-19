"use client";

import { listSkills, type SkillScope } from "../../lib/admin/api/team/skills";
import { forkToDraft } from "../../lib/skills/drafts-api";
import { MutationStatus } from "../admin/error-notice";
import { useMutation } from "../admin/use-resource";
import { draftHref } from "./draft-href";
import {
  Button,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../ui/console";
import { useTeamAccess } from "../admin/console-context";
import { DateTime, ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";

const TITLES: Readonly<Record<SkillScope, string>> = {
  team: "Team skills",
  personal: "My personal skills",
};

const EMPTY: Readonly<Record<SkillScope, string>> = {
  team: "The team has no skills yet. Write one in the Workbench and save it to the team.",
  personal: "You have no personal skills yet. Write one in the Workbench and save it as yours.",
};

/**
 * The team's skills, or the caller's personal ones, with their latest version (KOBE-321). "Edit
 * in Workbench" forks the latest version under the skill's own name (KOBE-322): saving the draft
 * makes the skill's next version.
 */
export function SkillList({ scope }: { readonly scope: SkillScope }) {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const canEdit = access.permissions.includes("team.personal.create");
  const { state } = useResource(() => listSkills(teamId, scope));
  const mutation = useMutation();
  const edit = (skillId: string) =>
    mutation.run(async () => {
      const res = await forkToDraft(teamId, { kind: scope, skillId });
      if (res.ok) window.location.assign(draftHref(res.data.id));
      return res;
    });
  return (
    <>
      <MutationStatus error={mutation.error} notice={null} />
      <ResourceView state={state} label={TITLES[scope].toLowerCase()}>
        {(skills) =>
          skills.length === 0 ? (
            <EmptyState title={EMPTY[scope]} />
          ) : (
            <Table caption={TITLES[scope]}>
              <TableHead>
                <TableRow>
                  <TableHeader>Skill</TableHeader>
                  <TableHeader>Latest version</TableHeader>
                  <TableHeader>Updated</TableHeader>
                  {canEdit && <TableHeader>Actions</TableHeader>}
                </TableRow>
              </TableHead>
              <TableBody>
                {skills.map((s) => (
                  <TableRow key={s.id}>
                    <TableRowHeader>
                      {s.slug}
                      <div className="text-sm font-normal text-console-muted">{s.description}</div>
                    </TableRowHeader>
                    <TableCell>v{s.latestSemver}</TableCell>
                    <TableCell>
                      <DateTime value={s.updatedAt} compact />
                    </TableCell>
                    {canEdit && (
                      <TableCell>
                        <Button
                          size="sm"
                          disabled={mutation.pending}
                          aria-label={`Edit ${s.slug} in the Workbench`}
                          onClick={() => void edit(s.id)}
                        >
                          Edit in Workbench
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        }
      </ResourceView>
    </>
  );
}
