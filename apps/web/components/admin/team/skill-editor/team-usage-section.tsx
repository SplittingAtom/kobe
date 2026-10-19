"use client";

import { getTeamSkillUsage, type TeamThumbs } from "../../../../lib/admin/api/team/skill-installs";
import { windowLabel } from "../../../../lib/skills/catalog-api";
import {
  EmptyState,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../../../ui/console";
import { useTeamAccess } from "../../console-context";
import { ResourceView } from "../../parts";
import { useResource } from "../../use-resource";

const few = (v: number | "few") => (v === "few" ? "Few" : String(v));
const thumbs = (t: TeamThumbs) =>
  t.enough ? `${t.up} up, ${t.down} down` : "Not enough ratings yet";

/**
 * This team's use of catalog skills (KOBE-339, SK26), for Team admins: runs, members and thumbs
 * per skill and version over the last closed 30-day period. Runs and members need three members
 * other than you, thumbs five raters (as the agents' ratings); nothing names a member.
 */
export function TeamUsageSection() {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => getTeamSkillUsage(teamId));
  return (
    <Section id="catalog-usage" title="Catalog skill usage">
      <ResourceView state={state} label="usage">
        {(data) => (
          <>
            <p className="text-sm text-console-muted">
              {windowLabel(data.window)}: the last closed 30-day period. Runs and members need three
              members other than you, thumbs five raters; otherwise Few.
            </p>
            {data.skills.length === 0 ? (
              <EmptyState title="No catalog skill was used here in the window." />
            ) : (
              <Table caption="Catalog skill usage">
                <TableHead>
                  <TableRow>
                    <TableHeader>Skill</TableHeader>
                    <TableHeader>Runs</TableHeader>
                    <TableHeader>Members</TableHeader>
                    <TableHeader>Thumbs</TableHeader>
                    <TableHeader>By version</TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.skills.map((s) => (
                    <TableRow key={s.skillId}>
                      <TableRowHeader>{s.name}</TableRowHeader>
                      <TableCell>{few(s.runs)}</TableCell>
                      <TableCell>{few(s.members)}</TableCell>
                      <TableCell>{thumbs(s.thumbs)}</TableCell>
                      <TableCell>
                        {s.versions === null
                          ? "Withheld: too few members"
                          : s.versions.map((v) => {
                              const vt = s.versionThumbs?.find((x) => x.semver === v.semver);
                              return (
                                <div key={v.semver} className="text-sm">
                                  {v.semver || "Unknown"}: {few(v.runs)} runs, {few(v.members)}{" "}
                                  members
                                  {vt ? `, ${thumbs(vt.thumbs)}` : ""}
                                </div>
                              );
                            })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </ResourceView>
    </Section>
  );
}
