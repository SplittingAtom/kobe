"use client";

import Link from "next/link";
import { listSkills } from "../../../../lib/admin/api/team/skills";
import {
  Button,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../../../ui/console";
import { useTeamAccess } from "../../console-context";
import { skillPaths, type SkillArea } from "./area";
import { DateTime, ResourceView } from "../../parts";
import { useResource } from "../../use-resource";

/**
 * Skills the caller can see; each one opens in the editor (KOBE-83). In the member's own area
 * (`area="my"`, KOBE-98) it lists personal skills only.
 */
export function SkillsPage({ area = "team" }: { readonly area?: SkillArea }) {
  const teamId = useTeamAccess().team.id;
  const paths = skillPaths(area);
  const { state } = useResource(() => listSkills(teamId, paths.listScope));
  return (
    <>
      <PageHeader
        title={paths.listTitle}
        description={`Saving a skill creates a new immutable version. ${
          area === "my"
            ? "Personal skills are only yours."
            : "Team skills are shared with the team; personal skills are only yours."
        }`}
        actions={
          <Button asChild variant="primary">
            <Link href={`${paths.base}/new`}>New skill</Link>
          </Button>
        }
      />
      <ResourceView state={state} label="skills">
        {(skills) =>
          skills.length === 0 ? (
            <EmptyState title="No skills yet." />
          ) : (
            <Table caption={paths.listTitle}>
              <TableHead>
                <TableRow>
                  <TableHeader>Skill</TableHeader>
                  {area === "team" && <TableHeader>Scope</TableHeader>}
                  <TableHeader>Latest version</TableHeader>
                  <TableHeader>Updated</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {skills.map((s) => (
                  <TableRow key={s.id}>
                    <TableRowHeader>
                      <Link href={`${paths.base}/${s.id}`}>{s.slug}</Link>
                      <div className="text-sm font-normal text-console-muted">{s.description}</div>
                    </TableRowHeader>
                    {area === "team" && (
                      <TableCell>{s.scope === "team" ? "Team" : "Personal"}</TableCell>
                    )}
                    <TableCell>v{s.latestSemver}</TableCell>
                    <TableCell>
                      <DateTime value={s.updatedAt} />
                    </TableCell>
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
