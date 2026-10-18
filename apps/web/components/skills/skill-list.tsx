"use client";

import { listSkills, type SkillScope } from "../../lib/admin/api/team/skills";
import {
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

/** The team's skills, or the caller's personal ones, with their latest version (KOBE-321). */
export function SkillList({ scope }: { readonly scope: SkillScope }) {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => listSkills(teamId, scope));
  return (
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      }
    </ResourceView>
  );
}
