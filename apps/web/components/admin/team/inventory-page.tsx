"use client";

import Link from "next/link";
import {
  EXPOSURE_LABELS,
  listTeamConnectors,
  type TeamConnector,
} from "../../../lib/admin/api/team/connectors";
import { listSkills, type SkillSummary } from "../../../lib/admin/api/team/skills";
import { consoleHref } from "../../../lib/admin/nav/registry";
import {
  Badge,
  EmptyState,
  PageHeader,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { DateTime, ResourceView } from "../parts";
import { useResource } from "../use-resource";
import { AgentInventory } from "./agent-inventory";

const TEAM = consoleHref("team");

/**
 * The team's inventory for team admins (spec D19, D32; KOBE-48): every agent used in the team with
 * owner, scope, status, versions, usage, schedules and Orbit score (suspend from here), then the
 * team's skills and the connectors enabled for it. Each list comes from the API its own page uses.
 */
export function TeamInventoryPage() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  return (
    <>
      <PageHeader
        title="Inventory"
        description={`Everything ${access.team.name}'s agents run with: the agents, their schedules and Orbit scores, the team's skills and its connectors.`}
      />
      <AgentInventory teamId={teamId} canSuspend />
      <SkillsInventory teamId={teamId} />
      <ConnectorsInventory teamId={teamId} />
    </>
  );
}

function SkillsInventory({ teamId }: { readonly teamId: string }) {
  const { state } = useResource(() => listSkills(teamId, "team"));
  return (
    <Section
      id="inventory-skills-heading"
      title="Skills"
      description={
        <>
          Team skills and their latest version. Edit them in{" "}
          <Link href={`${TEAM}/skills`}>Skills</Link>; approve versions in{" "}
          <Link href={`${TEAM}/skill-review`}>Skill review</Link>.
        </>
      }
    >
      <ResourceView state={state} label="team skills">
        {(skills) =>
          skills.length === 0 ? (
            <EmptyState title="The team has no skills yet." />
          ) : (
            <SkillsTable skills={skills} />
          )
        }
      </ResourceView>
    </Section>
  );
}

function SkillsTable({ skills }: { readonly skills: readonly SkillSummary[] }) {
  return (
    <Table caption="Team skills" hideCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Skill</TableHeader>
          <TableHeader>Latest version</TableHeader>
          <TableHeader>Updated</TableHeader>
          <TableHeader>
            <span className="sr-only">Actions</span>
          </TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {skills.map((s) => (
          <TableRow key={s.id}>
            <TableRowHeader>
              <code>{s.slug}</code>
              {s.description && (
                <div className="text-sm font-normal text-console-muted">{s.description}</div>
              )}
            </TableRowHeader>
            <TableCell>v{s.latestSemver}</TableCell>
            <TableCell>
              <DateTime value={s.updatedAt} />
            </TableCell>
            <TableCell>
              <Link href={`${TEAM}/skills/${encodeURIComponent(s.id)}`}>
                Open
                <span className="sr-only"> {s.slug}</span>
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ConnectorsInventory({ teamId }: { readonly teamId: string }) {
  const { state } = useResource(() => listTeamConnectors(teamId));
  return (
    <Section
      id="inventory-connectors-heading"
      title="Connectors"
      description={
        <>
          Connectors enabled for the team and the tools they expose. Change them in{" "}
          <Link href={`${TEAM}/connectors`}>Connectors</Link>.
        </>
      }
    >
      <ResourceView state={state} label="team connectors">
        {(all) => {
          const enabled = all.filter((c) => c.enabled);
          return enabled.length === 0 ? (
            <EmptyState title="No connectors are enabled for the team." />
          ) : (
            <ConnectorsTable connectors={enabled} />
          );
        }}
      </ResourceView>
    </Section>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function ConnectorsTable({ connectors }: { readonly connectors: readonly TeamConnector[] }) {
  return (
    <Table caption="Enabled connectors" hideCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Connector</TableHeader>
          <TableHeader>On the site</TableHeader>
          <TableHeader>Exposure</TableHeader>
          <TableHeader>Tools</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {connectors.map((c) => {
          const drifted = c.tools.filter((t) => t.status === "drifted").length;
          return (
            <TableRow key={c.id}>
              <TableRowHeader>{c.name}</TableRowHeader>
              <TableCell>
                {c.status === "active" ? (
                  <Badge tone="running">Active</Badge>
                ) : (
                  <Badge tone="failed">Disabled by a site admin</Badge>
                )}
              </TableCell>
              <TableCell>{c.exposure === null ? "—" : EXPOSURE_LABELS[c.exposure]}</TableCell>
              <TableCell>
                {c.exposure === "custom"
                  ? `${plural(c.enabledTools.length, "tool", "tools")} chosen of ${c.tools.length}`
                  : plural(c.tools.length, "tool", "tools")}
                {drifted > 0 && (
                  <>
                    {" "}
                    <Badge tone="attention">{drifted} awaiting re-approval</Badge>
                  </>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
