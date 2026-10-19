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
import { CatalogInstallsSection } from "./catalog-installs-section";
import { CatalogSwitchesSection } from "./catalog-switches";
import { PromotionRequestsSection } from "./promotion-requests-section";
import { DateTime, ResourceView } from "../../parts";
import { useResource } from "../../use-resource";

/**
 * The team's skills in the Team console (KOBE-83; admin view since KOBE-321): each opens its
 * access and reach settings; catalog installs and switches follow. Skills are written in the
 * member's Workbench (spec SK9).
 */
export function SkillsPage() {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => listSkills(teamId, "team"));
  return (
    <>
      <PageHeader
        title="Skills"
        description="Team skills, their access and the agents they reach. Skills are written in the Workbench; a saved team version waits in Skill review."
        actions={
          <Button asChild variant="primary">
            <Link href="/me/skills?tab=workbench">Open the Workbench</Link>
          </Button>
        }
      />
      <ResourceView state={state} label="skills">
        {(skills) =>
          skills.length === 0 ? (
            <EmptyState title="No team skills yet." />
          ) : (
            <Table caption="Team skills">
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
                      <Link href={`/admin/team/skills/${encodeURIComponent(s.id)}`}>{s.slug}</Link>
                      <div className="text-sm font-normal text-console-muted">{s.description}</div>
                    </TableRowHeader>
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
      <CatalogInstallsSection />
      <CatalogSwitchesSection />
      <PromotionRequestsSection />
    </>
  );
}
