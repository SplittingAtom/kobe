"use client";

import Link from "next/link";
import {
  dismissInstallRequests,
  listInstallRequests,
  listMemberAdds,
  listTeamBlocks,
  retirementText,
  unblockSkill,
  type InstallRequest,
  type MemberAdd,
  type TeamBlock,
} from "../../../../lib/admin/api/team/skill-installs";
import {
  Button,
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
import { catalogHref } from "../../../skills/catalog-tab";
import { PIN_LABELS } from "../../../skills/catalog-member";
import { useTeamAccess } from "../../console-context";
import { MutationStatus } from "../../error-notice";
import { DateTime, ResourceView } from "../../parts";
import { useMutation, useResource } from "../../use-resource";

function AddsTable({ adds }: { readonly adds: readonly MemberAdd[] }) {
  if (adds.length === 0) return <EmptyState title="No member has added a catalog skill." />;
  return (
    <Table caption="Member adds">
      <TableHead>
        <TableRow>
          <TableHeader>Skill</TableHeader>
          <TableHeader>Member</TableHeader>
          <TableHeader>Version</TableHeader>
          <TableHeader>Updated</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {adds.map((a) => (
          <TableRow key={`${a.skillId}:${a.userId}`}>
            <TableRowHeader>{a.name}</TableRowHeader>
            <TableCell>{a.memberName}</TableCell>
            <TableCell>
              {a.semver}, {PIN_LABELS[a.pinMode]}
              <div className="text-sm text-console-muted">
                {a.runs ? `runs ${a.runs}` : "no version can run"}
              </div>
              {a.retirement && <div className="text-sm">{retirementText(a.retirement)}</div>}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              <DateTime value={a.updatedAt} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Members and the Catalog in the Team console (KOBE-338, SK25), for Team admins: the members' own
 * adds, the catalog skills the team blocks (Unblock; a block is set from the skill's catalog
 * page), and members' Request for team (open the skill to install it, or Dismiss).
 */
export function MemberAddsSection() {
  const teamId = useTeamAccess().team.id;
  const adds = useResource(() => listMemberAdds(teamId));
  const blocks = useResource(() => listTeamBlocks(teamId));
  const requests = useResource(() => listInstallRequests(teamId));
  const mutation = useMutation();

  async function unblock(b: TeamBlock) {
    const done = await mutation.run(
      () => unblockSkill(teamId, b.skillId),
      () => `Unblocked ${b.name}.`,
    );
    if (done) blocks.reload();
  }

  async function dismiss(r: InstallRequest) {
    const done = await mutation.run(
      () => dismissInstallRequests(teamId, r.skillId),
      () => `Dismissed the requests for ${r.name}.`,
    );
    if (done) requests.reload();
  }

  return (
    <Section id="member-adds" title="Members and the catalog">
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={requests.state} label="requests">
        {(data) =>
          data.requests.length > 0 && (
            <Table caption="Requested by members">
              <TableHead>
                <TableRow>
                  <TableHeader>Skill</TableHeader>
                  <TableHeader>Asked by</TableHeader>
                  <TableHeader>Last asked</TableHeader>
                  <TableHeader>
                    <span className="sr-only">Actions</span>
                  </TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.requests.map((r) => (
                  <TableRow key={r.skillId}>
                    <TableRowHeader>
                      <Link href={catalogHref(r.skillId)}>{r.name}</Link>
                      <div className="text-sm font-normal text-console-muted">
                        {r.installed ? `Installed at ${r.installed}: a change` : "Not installed"}
                      </div>
                    </TableRowHeader>
                    <TableCell>{r.requesters.map((u) => u.name).join(", ")}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <DateTime value={r.lastAt} />
                    </TableCell>
                    <TableCell>
                      <Button
                        disabled={mutation.pending}
                        aria-label={`Dismiss requests for ${r.name}`}
                        onClick={() => void dismiss(r)}
                      >
                        Dismiss
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        }
      </ResourceView>
      <ResourceView state={adds.state} label="member adds">
        {(data) => <AddsTable adds={data.adds} />}
      </ResourceView>
      <ResourceView state={blocks.state} label="blocks">
        {(data) =>
          data.blocks.length > 0 && (
            <Table caption="Blocked catalog skills">
              <TableHead>
                <TableRow>
                  <TableHeader>Skill</TableHeader>
                  <TableHeader>Blocked by</TableHeader>
                  <TableHeader>Since</TableHeader>
                  <TableHeader>
                    <span className="sr-only">Actions</span>
                  </TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.blocks.map((b) => (
                  <TableRow key={b.skillId}>
                    <TableRowHeader>{b.name}</TableRowHeader>
                    <TableCell>{b.blockedByName}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <DateTime value={b.at} />
                    </TableCell>
                    <TableCell>
                      <Button
                        disabled={mutation.pending}
                        aria-label={`Unblock ${b.name}`}
                        onClick={() => void unblock(b)}
                      >
                        Unblock
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        }
      </ResourceView>
    </Section>
  );
}
